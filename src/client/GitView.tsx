/**
 * The source-control panel: status list (staged vs unstaged), stage/unstage,
 * commit with a message box, branch switch, and a VSCode-like history — rows
 * carry branch decorations, author and relative time. Clicking a changed
 * file or a history row opens a dedicated diff TAB (see {@link DiffTab}),
 * placed below the git pane on first use. File rows and history rows open a
 * right-click context menu with advanced operations (open in editor, discard,
 * revert, cherry-pick, copy paths/hashes). Refresh is manual + on mount/
 * focus (no file watcher — KISS).
 *
 * The layout mirrors code-server's single-repository SCM view: the commit
 * message input and Commit button sit at the TOP (above the file lists),
 * followed by collapsible "Staged Changes" and "Changes" sections whose
 * group headers carry a count badge and hover-revealed action buttons.
 * File rows are 22px tall with hover-revealed stage/unstage/discard actions.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Button, IconBranchOutline16, IconCodeOutline16, IconCopyOutline16, IconRefreshOutline16,
  IconTrashOutline16, Menu, Modal, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitLogEntry, GitStatusEntry, GitStatusResult, SessionScope } from './api.ts'
import { api } from './api.ts'
import { relativeTo } from './paths.ts'
import { relativeTime, t } from './locales.ts'
import type { SidebarTab } from './state.ts'
import { parseUnifiedDiff } from './DiffView.tsx'
import {
  IconAdd16, IconCheck16, IconChevronDown16, IconChevronRight16, IconDiffMultiple16,
  IconDiscard16, IconGoToFile16, IconRemove16,
  IconPush16, IconPull16, IconSync16,
} from './icons.tsx'
import css from './sidebar.module.css'

/** The XY status letters a row badge shows (X = index, Y = worktree). */
function badgeOf(entry: GitStatusEntry): string {
  const index = entry.xy[0]
  const worktree = entry.xy[1]
  if (index !== undefined && index !== ' ' && index !== '?') return index
  if (worktree !== undefined && worktree !== ' ' && worktree !== '?') return worktree
  return '?'
}

/** Whether the entry carries STAGED (index) changes — the X letter is set. */
function isStagedEntry(entry: GitStatusEntry): boolean {
  const index = entry.xy[0]
  return index !== undefined && index !== ' ' && index !== '?'
}

/** Whether the entry carries UNSTAGED (worktree) changes — the Y letter is set
 *  (untracked `??` counts as unstaged: it is a worktree-only change). A file
 *  with both letters set ('MM') lands in BOTH sections. */
function isUnstagedEntry(entry: GitStatusEntry): boolean {
  if (entry.xy === '??') return true
  const worktree = entry.xy[1]
  return worktree !== undefined && worktree !== ' ' && worktree !== '?'
}

/** Whether the entry is untracked (`??`): git diff never includes it. */
function isUntracked(entry: GitStatusEntry): boolean {
  return badgeOf(entry) === '?'
}

/** The last path segment (tab title for a file's diff). */
function baseName(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/** Strip the `a/` / `b/` prefix git puts on diff paths (not on /dev/null). */
function displayPath(path: string): string {
  if (path === '/dev/null') return path
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2)
  return path
}

/** The ref names of one log row's decorations (`HEAD -> main` → `main`), deduped. */
function refNames(refs: string): string[] {
  return [...new Set(
    refs
      .split(',')
      .map(ref => ref.trim())
      .filter(ref => ref !== '')
      .map(ref => (ref.includes(' -> ') ? ref.slice(ref.indexOf(' -> ') + 4) : ref))
      .map(ref => (ref.startsWith('tag: ') ? ref.slice(5) : ref)),
  )]
}

/** One node in the file-path tree (a directory or a leaf file entry). */
interface PathTreeNode {
  /** The segment name (directory name or file base name). */
  name: string
  /** The full path from the repo root (for files) or the directory prefix (for dirs). */
  path: string
  /** Child directories and files (empty for leaf files). */
  children: PathTreeNode[]
  /** The git status entry (only for leaf files; undefined for directories). */
  entry?: GitStatusEntry
}

/**
 * Build a directory tree from a list of git status entries. Files in the
 * root directory sit at the top level; nested files are grouped under
 * directory nodes. Directories with a single child subdirectory are NOT
 * collapsed (unlike VSCode's explorer) — the tree mirrors the real path
 * structure so the user can navigate it.
 */
function buildPathTree(entries: GitStatusEntry[]): PathTreeNode[] {
  const root: PathTreeNode = { name: '', path: '', children: [] }
  for (const entry of entries) {
    insertPathIntoTree(root, entry.path, entry)
  }
  sortPathTree(root)
  return root.children
}

/**
 * Build a directory tree from a list of plain path strings (used by the
 * commit-history file list, which has no git status entries — just paths).
 * Leaf nodes carry no `entry`; the tree structure is identical to
 * {@link buildPathTree} so the two render with the same indentation.
 */
function buildPathTreeFromStrings(paths: string[]): PathTreeNode[] {
  const root: PathTreeNode = { name: '', path: '', children: [] }
  for (const path of paths) {
    insertPathIntoTree(root, path, undefined)
  }
  sortPathTree(root)
  return root.children
}

/** Insert one path (with an optional status entry) into the tree. */
function insertPathIntoTree(root: PathTreeNode, path: string, entry: GitStatusEntry | undefined): void {
  const parts = path.split('/')
  let node = root
  let prefix = ''
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    prefix = prefix === '' ? part : `${prefix}/${part}`
    const isLeaf = i === parts.length - 1
    let child = node.children.find(c => c.name === part && (isLeaf ? c.entry !== undefined : c.entry === undefined))
    if (child === undefined) {
      child = { name: part, path: prefix, children: [], entry: isLeaf ? entry : undefined }
      node.children.push(child)
    }
    node = child
  }
}

/** Sort: directories first (alphabetical), then files (alphabetical). */
function sortPathTree(root: PathTreeNode): void {
  root.children.sort((a, b) => {
    const aDir = a.entry === undefined
    const bDir = b.entry === undefined
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const c of root.children) sortPathTree(c)
}

/** The pending destructive action (discard / revert / cherry-pick), gated by a confirm modal. */
interface ConfirmState {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => Promise<unknown>
}

/** History batch size: the log loads lazily in pages so a long history never
 *  floods the panel at once (the end of the log is reached by paging). */
const LOG_BATCH = 20

export function GitView(props: {
  scope: SessionScope
  onOpenFile: (path: string) => void
  /** Open a diff tab (the shell places it below the git pane on first use). */
  onOpenDiff: (tab: SidebarTab) => void
}) {
  const { scope, onOpenFile, onOpenDiff } = props
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [branchNames, setBranchNames] = useState<string[]>([])
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([])
  const [commitMsg, setCommitMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  /** Whether the history was fully paged (a batch shorter than LOG_BATCH). */
  const [logEnded, setLogEnded] = useState(false)
  const [logLoadingMore, setLogLoadingMore] = useState(false)

  /** The open file-row context menu (cursor position for the portaled Menu). */
  const [fileMenu, setFileMenu] = useState<{ entry: GitStatusEntry; staged: boolean; x: number; y: number } | null>(null)
  /** The open history-row context menu. */
  const [historyMenu, setHistoryMenu] = useState<{ entry: GitLogEntry; x: number; y: number } | null>(null)
  /** The pending destructive action awaiting confirmation. */
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  /** Collapsible section state (mirroring code-server's twistie behavior). */
  const [stagedCollapsed, setStagedCollapsed] = useState(false)
  const [changesCollapsed, setChangesCollapsed] = useState(false)
  const [historyCollapsed, setHistoryCollapsed] = useState(false)
  /** Collapsed directory nodes in the staged/changes trees (keyed by `s:`/`u:` + dir path). */
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())
  /** Expanded commits in the history tree (hashFull → true). */
  const [expandedCommits, setExpandedCommits] = useState<Set<string>>(new Set())
  /** Cached file lists per commit (hashFull → string[] of paths). */
  const [commitFiles, setCommitFiles] = useState<Map<string, string[]>>(new Map())
  /** Commits whose file list is currently loading. */
  const [commitFilesLoading, setCommitFilesLoading] = useState<Set<string>>(new Set())

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [statusResult, branchResult, logResult] = await Promise.all([
        api.gitStatus(scope),
        api.gitBranch(scope).catch(() => ({ current: '', names: [] as string[] })),
        // The first history page only; the rest arrives via "load more".
        api.gitLog(scope, LOG_BATCH, 0).catch(() => [] as GitLogEntry[]),
      ])
      setStatus(statusResult)
      setBranchNames(branchResult.names)
      setLogEntries(logResult)
      setLogEnded(logResult.length < LOG_BATCH)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [scope.sessionId, scope.cwd])

  useEffect(() => { void refresh() }, [refresh])

  /** Append the next history page (lazy: only when the user asks for more). */
  const loadMoreLog = async (): Promise<void> => {
    if (logLoadingMore || logEnded) return
    setLogLoadingMore(true)
    try {
      const next = await api.gitLog(scope, LOG_BATCH, logEntries.length)
      setLogEntries(entries => [...entries, ...next])
      if (next.length < LOG_BATCH) setLogEnded(true)
    } catch (reason) {
      setCommitError(`${t('historyLoadError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setLogLoadingMore(false)
    }
  }

  /** The diff tab for one changed file (one tab per path+side; same id = focused). */
  const openWorktreeDiff = (entry: GitStatusEntry, staged: boolean): void => {
    onOpenDiff({
      id: `diff:w:${staged ? 's' : 'u'}:${entry.path}`,
      type: 'diff',
      title: baseName(entry.path),
      diff: { kind: 'worktree', path: entry.path, staged, untracked: isUntracked(entry) },
    })
  }

  /** The diff tab for one commit (one tab per commit). */
  const openCommitDiff = (entry: GitLogEntry): void => {
    onOpenDiff({
      id: `diff:c:${entry.hashFull}`,
      type: 'diff',
      title: `${entry.hash} ${entry.subject}`,
      diff: { kind: 'commit', hash: entry.hash, hashFull: entry.hashFull, subject: entry.subject },
    })
  }

  /** The diff tab for one file within a commit (tree-structured history).
   *  The official diff-tab types only carry whole commits, so the file click
   *  opens the commit's full patch (the same surface as the commit row). */
  const openCommitFileDiff = (entry: GitLogEntry, _path: string): void => {
    openCommitDiff(entry)
  }

  /** Toggle a commit's expansion in the history tree; on first expand,
   *  fetch the commit's file list (cached per hashFull). */
  const toggleCommitExpansion = async (entry: GitLogEntry): Promise<void> => {
    const hashFull = entry.hashFull
    const next = new Set(expandedCommits)
    if (next.has(hashFull)) {
      next.delete(hashFull)
      setExpandedCommits(next)
      return
    }
    next.add(hashFull)
    setExpandedCommits(next)
    // Load the file list if not cached.
    if (commitFiles.has(hashFull)) return
    if (commitFilesLoading.has(hashFull)) return
    const loadingSet = new Set(commitFilesLoading)
    loadingSet.add(hashFull)
    setCommitFilesLoading(loadingSet)
    try {
      const result = await api.gitCommitDiff(scope, hashFull)
      const parsed = parseUnifiedDiff(result.diff)
      const paths = parsed.files.map(f => displayPath(f.newPath === '/dev/null' ? f.oldPath : f.newPath))
      setCommitFiles(prev => { const m = new Map(prev); m.set(hashFull, paths); return m })
    } catch {
      // On error, collapse back so the user can retry.
      const collapse = new Set(expandedCommits)
      collapse.delete(hashFull)
      setExpandedCommits(collapse)
    } finally {
      const done = new Set(commitFilesLoading)
      done.delete(hashFull)
      setCommitFilesLoading(done)
    }
  }

  const stageEntry = async (entry: GitStatusEntry, staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await api.gitUnstage(scope, entry.path)
      else await api.gitStage(scope, entry.path)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const stageAll = async (staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await api.gitUnstage(scope)
      else await api.gitStage(scope)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  /** Stage or unstage an entire directory by its path prefix. git add -A --
   *  <dir> and git reset -q -- <dir> both recurse into the directory, so a
   *  single call handles every file under it. */
  const stageDir = async (dirPath: string, staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await api.gitUnstage(scope, dirPath)
      else await api.gitStage(scope, dirPath)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const commit = async (): Promise<void> => {
    const message = commitMsg.trim()
    if (message === '' || busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitCommit(scope, message)
      setCommitMsg('')
      await refresh()
    } catch (reason) {
      setCommitError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const checkout = async (branch: string): Promise<void> => {
    if (branch === status?.branch || busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitCheckout(scope, branch)
      await refresh()
    } catch (reason) {
      setCommitError(`${t('checkoutError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  /** Push the current branch to its upstream (sets up -u origin when none). */
  const push = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitPush(scope)
      await refresh()
    } catch (reason) {
      setCommitError(`${t('pushError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  /** Pull the current branch from its upstream (fetch + merge). */
  const pull = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitPull(scope)
      await refresh()
    } catch (reason) {
      setCommitError(`${t('pullError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  /** Fetch from the default remote without merging. */
  const fetch = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitFetch(scope)
      await refresh()
    } catch (reason) {
      setCommitError(`${t('fetchError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  /** Run one destructive operation after the confirm modal, then refresh. */
  const runConfirmed = (confirmState: ConfirmState): void => {
    setConfirm({ ...confirmState, onConfirm: async () => {
      setBusy(true)
      setCommitError(null)
      try {
        await confirmState.onConfirm()
        await refresh()
      } catch (reason) {
        setCommitError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    } })
  }

  /** Copy `text` to the clipboard (best-effort; no visual feedback needed — the menu closes). */
  const copy = (text: string): void => {
    void writeClipboard(text)
  }

  const openFileMenu = (event: MouseEvent, entry: GitStatusEntry, staged: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setFileMenu({ entry, staged, x: event.clientX, y: event.clientY })
  }

  const openHistoryMenu = (event: MouseEvent, entry: GitLogEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    setHistoryMenu({ entry, x: event.clientX, y: event.clientY })
  }

  const stagedEntries = (status?.entries ?? []).filter(isStagedEntry)
  const unstagedEntries = (status?.entries ?? []).filter(isUnstagedEntry)

  /** Toggle a directory's collapse state in the staged/changes trees. */
  const toggleDir = (key: string): void => {
    setCollapsedDirs(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** Render one tree node (a directory or a file row) recursively. */
  const renderTreeNode = (node: PathTreeNode, staged: boolean, depth: number): ReactNode => {
    const key = `${staged ? 's' : 'u'}:${node.path}`
    if (node.entry !== undefined) {
      // Leaf file row.
      const entry = node.entry
      return (
        <div key={key} className={css.gitRow} style={{ paddingLeft: `${depth * 12}px` }}>
          <button
            type="button"
            className={css.gitRowMain}
            title={entry.path}
            onClick={() => { openWorktreeDiff(entry, staged) }}
            onContextMenu={(event) => { openFileMenu(event, entry, staged) }}
          >
            <span className={css.gitBadge}>{badgeOf(entry)}</span>
            <span className={css.gitName}>{node.name}</span>
          </button>
          <div className={css.gitRowActions}>
            {staged ? (
              <button
                type="button"
                className={css.gitRowAction}
                aria-label={t('unstage')}
                title={t('unstage')}
                disabled={busy}
                onClick={() => { void stageEntry(entry, staged) }}
              >
                <IconRemove16 size={14} />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={css.gitRowAction}
                  aria-label={t('openFile')}
                  title={t('openFile')}
                  onClick={() => { onOpenFile(entry.path) }}
                >
                  <IconGoToFile16 size={14} />
                </button>
                <button
                  type="button"
                  className={css.gitRowAction}
                  aria-label={t('discard')}
                  title={t('discard')}
                  disabled={busy}
                  onClick={() => {
                    runConfirmed({
                      title: t('discardTitle'),
                      description: t('discardDesc', { path: entry.path }),
                      confirmLabel: t('discard'),
                      onConfirm: () => api.gitDiscard(scope, entry.path),
                    })
                  }}
                >
                  <IconDiscard16 size={14} />
                </button>
                <button
                  type="button"
                  className={css.gitRowAction}
                  aria-label={t('stage')}
                  title={t('stage')}
                  disabled={busy}
                  onClick={() => { void stageEntry(entry, staged) }}
                >
                  <IconAdd16 size={14} />
                </button>
              </>
            )}
          </div>
        </div>
      )
    }
    // Directory node.
    const collapsed = collapsedDirs.has(key)
    return (
      <div key={key}>
        <div
          role="button"
          tabIndex={0}
          className={css.gitDirRow}
          style={{ paddingLeft: `${depth * 12}px` }}
          title={node.path}
          onClick={() => { toggleDir(key) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggleDir(key)
            }
          }}
        >
          <span className={css.gitDirTwistie}>
            {collapsed ? <IconChevronRight16 size={12} /> : <IconChevronDown16 size={12} />}
          </span>
          <span className={css.gitDirName}>{node.name}</span>
          <div className={css.gitRowActions}>
            {staged ? (
              <button
                type="button"
                className={css.gitRowAction}
                aria-label={t('unstage')}
                title={t('unstage')}
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation()
                  void stageDir(node.path, staged)
                }}
              >
                <IconRemove16 size={14} />
              </button>
            ) : (
              <button
                type="button"
                className={css.gitRowAction}
                aria-label={t('stage')}
                title={t('stage')}
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation()
                  void stageDir(node.path, staged)
                }}
              >
                <IconAdd16 size={14} />
              </button>
            )}
          </div>
        </div>
        {!collapsed && node.children.map(child => renderTreeNode(child, staged, depth + 1))}
      </div>
    )
  }

  /** Render a tree of entries (staged or unstaged) with directory grouping. */
  const renderTree = (entries: GitStatusEntry[], staged: boolean): ReactNode => {
    const tree = buildPathTree(entries)
    return tree.map(node => renderTreeNode(node, staged, 0))
  }

  /**
   * Render a tree of commit-history file paths (no git status entries —
   * just path strings). Shares the directory-row visuals with
   * {@link renderTreeNode} but the leaf rows open a commit-file diff
   * instead of a worktree diff. Directory collapse state is keyed by the
   * commit hash + path so two commits' trees expand independently.
   */
  const renderCommitFileTree = (entry: GitLogEntry, paths: string[], depth: number): ReactNode => {
    const tree = buildPathTreeFromStrings(paths)
    return tree.map(node => renderCommitFileNode(entry, node, depth))
  }

  const renderCommitFileNode = (entry: GitLogEntry, node: PathTreeNode, depth: number): ReactNode => {
    const key = `cf:${entry.hashFull}:${node.path}`
    if (node.entry === undefined && node.children.length > 0) {
      // Directory node.
      const collapsed = collapsedDirs.has(key)
      return (
        <div key={key}>
          <div
            role="button"
            tabIndex={0}
            className={css.gitDirRow}
            style={{ paddingLeft: `${depth * 12}px` }}
            title={node.path}
            onClick={() => { toggleDir(key) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                toggleDir(key)
              }
            }}
          >
            <span className={css.gitDirTwistie}>
              {collapsed ? <IconChevronRight16 size={12} /> : <IconChevronDown16 size={12} />}
            </span>
            <span className={css.gitDirName}>{node.name}</span>
          </div>
          {!collapsed && node.children.map(child => renderCommitFileNode(entry, child, depth + 1))}
        </div>
      )
    }
    // Leaf file row.
    return (
      <div
        key={key}
        role="button"
        tabIndex={0}
        className={css.gitCommitFile}
        style={{ paddingLeft: `${depth * 12}px` }}
        title={node.path}
        onClick={() => { openCommitFileDiff(entry, node.path) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openCommitFileDiff(entry, node.path)
          }
        }}
      >
        <span className={css.gitCommitFileIcon}><IconGoToFile16 size={12} /></span>
        <span className={css.gitCommitFilePath}>{node.name}</span>
      </div>
    )
  }

  return (
    <div className={css.git}>
      <div className={css.gitHeader}>
        <select
          className={css.gitBranchSelect}
          value={status?.branch ?? ''}
          onChange={(event) => { void checkout(event.target.value) }}
          disabled={busy || (status !== null && !status.isRepo)}
        >
          {(status?.branch ?? '') !== '' && <option value={status!.branch}>{status!.branch}</option>}
          {branchNames.filter(name => name !== status?.branch).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { void refresh() }}
        >
          <IconRefreshOutline16 size={14} />
        </button>
      </div>

      {loading && <div className={css.gitPlaceholder}>{t('loading')}</div>}
      {!loading && error !== null && <div className={css.gitError}>{error}</div>}
      {!loading && status !== null && !status.isRepo && (
        <div className={css.gitPlaceholder}>{t('notRepo')}</div>
      )}

      {status !== null && status.isRepo && (
        <>
          {/* ── Commit message input + Commit button (code-server style: at the TOP) ── */}
          <div className={css.gitCommitArea}>
            <div className={css.gitCommitInputRow}>
              <input
                className={css.gitCommitInput}
                placeholder={t('commitPlaceholder', { branch: status.branch ?? '' })}
                value={commitMsg}
                disabled={busy}
                onChange={(event) => { setCommitMsg(event.target.value); setCommitError(null) }}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void commit()
                }}
              />
            </div>
            <div className={css.gitCommitButtonRow}>
              <button
                type="button"
                className={css.gitCommitButton}
                disabled={busy || commitMsg.trim() === '' || stagedEntries.length === 0}
                onClick={() => { void commit() }}
              >
                <IconCheck16 size={14} />
                <span>{t('commit')}</span>
              </button>
            </div>
          </div>
          {commitError !== null && <div className={css.gitError}>{commitError}</div>}

          {/* ── Staged Changes section (collapsible, with count badge) ── */}
          <div className={css.gitSection}>
            <div
              className={css.gitSectionHeader}
              onClick={() => { setStagedCollapsed(!stagedCollapsed) }}
            >
              <span className={css.gitTwistie}>
                {stagedCollapsed ? <IconChevronRight16 size={14} /> : <IconChevronDown16 size={14} />}
              </span>
              <span className={css.gitSectionTitle}>{t('stagedChanges')}</span>
              <span className={css.gitCountBadge}>{stagedEntries.length}</span>
              <div className={css.gitSectionActions}>
                {stagedEntries.length > 0 && (
                  <>
                    <button
                      type="button"
                      className={css.gitSectionAction}
                      aria-label={t('openStagedChanges')}
                      title={t('openStagedChanges')}
                      onClick={(event) => {
                        event.stopPropagation()
                        // Open diff for the first staged entry
                        if (stagedEntries.length > 0) openWorktreeDiff(stagedEntries[0]!, true)
                      }}
                    >
                      <IconDiffMultiple16 size={14} />
                    </button>
                    <button
                      type="button"
                      className={css.gitSectionAction}
                      aria-label={t('unstageAllChanges')}
                      title={t('unstageAllChanges')}
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation()
                        void stageAll(true)
                      }}
                    >
                      <IconRemove16 size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
            {!stagedCollapsed && stagedEntries.length === 0 && (
              <div className={css.gitEmpty}>{t('noChanges')}</div>
            )}
            {!stagedCollapsed && renderTree(stagedEntries, true)}
          </div>

          {/* ── Changes section (collapsible, with count badge) ── */}
          <div className={css.gitSection}>
            <div
              className={css.gitSectionHeader}
              onClick={() => { setChangesCollapsed(!changesCollapsed) }}
            >
              <span className={css.gitTwistie}>
                {changesCollapsed ? <IconChevronRight16 size={14} /> : <IconChevronDown16 size={14} />}
              </span>
              <span className={css.gitSectionTitle}>{t('unstagedChanges')}</span>
              <span className={css.gitCountBadge}>{unstagedEntries.length}</span>
              <div className={css.gitSectionActions}>
                {unstagedEntries.length > 0 && (
                  <>
                    <button
                      type="button"
                      className={css.gitSectionAction}
                      aria-label={t('openChanges')}
                      title={t('openChanges')}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (unstagedEntries.length > 0) openWorktreeDiff(unstagedEntries[0]!, false)
                      }}
                    >
                      <IconDiffMultiple16 size={14} />
                    </button>
                    <button
                      type="button"
                      className={css.gitSectionAction}
                      aria-label={t('discardAll')}
                      title={t('discardAll')}
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation()
                        // Discard all unstaged changes one by one (the API
                        // has no bulk discard; untracked files are skipped
                        // because gitDiscard only touches tracked files).
                        const tracked = unstagedEntries.filter(e => !isUntracked(e))
                        if (tracked.length === 0) return
                        runConfirmed({
                          title: t('discardTitle'),
                          description: t('discardDesc', { path: t('unstagedChanges') }),
                          confirmLabel: t('discard'),
                          onConfirm: async () => {
                            for (const entry of tracked) {
                              await api.gitDiscard(scope, entry.path)
                            }
                          },
                        })
                      }}
                    >
                      <IconDiscard16 size={14} />
                    </button>
                    <button
                      type="button"
                      className={css.gitSectionAction}
                      aria-label={t('stageAllChanges')}
                      title={t('stageAllChanges')}
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation()
                        void stageAll(false)
                      }}
                    >
                      <IconAdd16 size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
            {!changesCollapsed && unstagedEntries.length === 0 && (
              <div className={css.gitEmpty}>{t('noChanges')}</div>
            )}
            {!changesCollapsed && renderTree(unstagedEntries, false)}
          </div>

          {/* ── History section (collapsible, pinned to the bottom so the
                staged/changes area above gets the room). The header carries
                the branch selector + sync/push/pull/refresh toolbar, matching
                code-server's "图表操作" toolbar. ── */}
          <div className={css.gitSectionHistory}>
            <div
              className={css.gitSectionHeader}
              onClick={() => { setHistoryCollapsed(!historyCollapsed) }}
            >
              <span className={css.gitTwistie}>
                {historyCollapsed ? <IconChevronRight16 size={14} /> : <IconChevronDown16 size={14} />}
              </span>
              <span className={css.gitSectionTitle}>{t('history')}</span>
              <span className={css.gitCountBadge}>{logEntries.length}</span>
              <div className={css.gitSectionActions} style={{ opacity: 1 }}>
                <select
                  className={css.gitBranchSelect}
                  value={status?.branch ?? ''}
                  onClick={(event) => { event.stopPropagation() }}
                  onChange={(event) => { void checkout(event.target.value) }}
                  disabled={busy || (status !== null && !status.isRepo)}
                >
                  {(status?.branch ?? '') !== '' && <option value={status!.branch}>{status!.branch}</option>}
                  {branchNames.filter(name => name !== status?.branch).map(name => <option key={name} value={name}>{name}</option>)}
                </select>
                <button
                  type="button"
                  className={css.gitSectionAction}
                  aria-label={t('fetch')}
                  title={t('fetch')}
                  disabled={busy}
                  onClick={(event) => { event.stopPropagation(); void fetch() }}
                >
                  <IconSync16 size={14} />
                </button>
                <button
                  type="button"
                  className={css.gitSectionAction}
                  aria-label={t('pull')}
                  title={t('pull')}
                  disabled={busy}
                  onClick={(event) => { event.stopPropagation(); void pull() }}
                >
                  <IconPull16 size={14} />
                </button>
                <button
                  type="button"
                  className={css.gitSectionAction}
                  aria-label={t('push')}
                  title={t('push')}
                  disabled={busy}
                  onClick={(event) => { event.stopPropagation(); void push() }}
                >
                  <IconPush16 size={14} />
                </button>
                <button
                  type="button"
                  className={css.gitSectionAction}
                  aria-label={t('refresh')}
                  title={t('refresh')}
                  disabled={busy}
                  onClick={(event) => { event.stopPropagation(); void refresh() }}
                >
                  <IconRefreshOutline16 size={14} />
                </button>
              </div>
            </div>
            {/* Ahead/behind status indicator (between header and tree). */}
            {status?.aheadBehind !== undefined && status.aheadBehind !== null && (status.aheadBehind.ahead > 0 || status.aheadBehind.behind > 0) && (
              <div className={css.gitAheadBehind}>
                {status.aheadBehind.ahead > 0 && status.aheadBehind.behind > 0
                  ? t('aheadBehind', { ahead: status.aheadBehind.ahead, behind: status.aheadBehind.behind })
                  : status.aheadBehind.ahead > 0
                    ? t('ahead', { n: status.aheadBehind.ahead })
                    : t('behind', { n: status.aheadBehind.behind })}
              </div>
            )}
            {!historyCollapsed && (
              <>
                {logEntries.map(entry => {
                  const expanded = expandedCommits.has(entry.hashFull)
                  const files = commitFiles.get(entry.hashFull)
                  const filesLoading = commitFilesLoading.has(entry.hashFull)
                  return (
                    <div key={entry.hashFull}>
                      <div
                        role="button"
                        tabIndex={0}
                        className={css.gitLogRow}
                        title={`${entry.author} · ${entry.date}\n${entry.hashFull}`}
                        onClick={() => { void toggleCommitExpansion(entry) }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            void toggleCommitExpansion(entry)
                          }
                        }}
                        onContextMenu={(event) => { openHistoryMenu(event, entry) }}
                      >
                        <span className={css.gitLogLine1}>
                          <span className={css.gitLogTwistie}>
                            {expanded ? <IconChevronDown16 size={12} /> : <IconChevronRight16 size={12} />}
                          </span>
                          <span className={css.gitLogHash}>{entry.hash}</span>
                          <span className={css.gitLogSubject}>{entry.subject}</span>
                        </span>
                        <span className={css.gitLogLine2}>
                          {refNames(entry.refs).map(ref => (
                            <span key={ref} className={css.gitLogRef}>{ref}</span>
                          ))}
                          <span className={css.gitLogMeta}>{entry.author} · {relativeTime(entry.date)}</span>
                        </span>
                      </div>
                      {expanded && (
                        <div className={css.gitCommitFiles}>
                          {filesLoading && files === undefined && (
                            <div className={css.gitCommitFileLoading}>{t('loading')}</div>
                          )}
                          {files !== undefined && files.length === 0 && (
                            <div className={css.gitCommitFileEmpty}>{t('noChanges')}</div>
                          )}
                          {files !== undefined && files.length > 0 && renderCommitFileTree(entry, files, 0)}
                        </div>
                      )}
                    </div>
                  )
                })}
                {!logEnded && (
                  <button
                    type="button"
                    className={css.gitLogMore}
                    disabled={logLoadingMore || busy}
                    onClick={() => { void loadMoreLog() }}
                  >
                    {logLoadingMore ? t('loading') : t('loadMore')}
                  </button>
                )}
              </>
            )}
          </div>

          {/*
            The one shared file-row context menu, positioned at the right-click
            cursor (portal so the panel's overflow clip cannot crop it).
          */}
          <Menu
            open={fileMenu !== null}
            onClose={() => { setFileMenu(null) }}
            items={[
              { id: 'open', label: t('openEditor'), icon: <IconCodeOutline16 size={14} /> },
              fileMenu?.staged === true
                ? { id: 'stage', label: t('unstage'), icon: <IconTrashOutline16 size={14} /> }
                : { id: 'stage', label: t('stage'), icon: <IconBranchOutline16 size={14} /> },
              ...(fileMenu !== null && !isUntracked(fileMenu.entry)
                ? [{ id: 'discard', label: t('discard'), icon: <IconTrashOutline16 size={14} />, danger: true }]
                : []),
              { type: 'separator', id: 'sep1' },
              { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> },
              { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
            ]}
            onSelect={(id) => {
              const target = fileMenu
              if (target === null) return
              setFileMenu(null)
              if (id === 'open') {
                onOpenFile(target.entry.path)
                return
              }
              if (id === 'stage') {
                void stageEntry(target.entry, target.staged)
                return
              }
              if (id === 'discard') {
                runConfirmed({
                  title: t('discardTitle'),
                  description: t('discardDesc', { path: target.entry.path }),
                  confirmLabel: t('discard'),
                  onConfirm: () => api.gitDiscard(scope, target.entry.path),
                })
                return
              }
              if (id === 'relative') {
                copy(relativeTo(scope.cwd ?? '', target.entry.path))
                return
              }
              if (id === 'absolute') copy(target.entry.path)
            }}
            portal
            align="start"
            getAnchorRect={() => (fileMenu === null ? null : new DOMRect(fileMenu.x, fileMenu.y, 0, 0))}
            anchor={<span />}
          />

          {/* The shared history-row context menu. */}
          <Menu
            open={historyMenu !== null}
            onClose={() => { setHistoryMenu(null) }}
            items={[
              { id: 'view', label: t('viewCommitDiff') },
              { id: 'copyShort', label: t('copyShortHash'), icon: <IconCopyOutline16 size={14} /> },
              { id: 'copyFull', label: t('copyFullHash'), icon: <IconCopyOutline16 size={14} /> },
              { id: 'copySubject', label: t('copySubject'), icon: <IconCopyOutline16 size={14} /> },
              { type: 'separator', id: 'sep2' },
              { id: 'revert', label: t('revertCommit'), danger: true },
              { id: 'cherryPick', label: t('cherryPickCommit'), danger: true },
            ]}
            onSelect={(id) => {
              const target = historyMenu
              if (target === null) return
              setHistoryMenu(null)
              if (id === 'view') {
                openCommitDiff(target.entry)
                return
              }
              if (id === 'copyShort') {
                copy(target.entry.hash)
                return
              }
              if (id === 'copyFull') {
                copy(target.entry.hashFull)
                return
              }
              if (id === 'copySubject') {
                copy(target.entry.subject)
                return
              }
              if (id === 'revert') {
                runConfirmed({
                  title: t('revertTitle'),
                  description: t('revertDesc', { subject: target.entry.subject }),
                  confirmLabel: t('revertCommit'),
                  onConfirm: () => api.gitRevert(scope, target.entry.hashFull),
                })
                return
              }
              if (id === 'cherryPick') {
                runConfirmed({
                  title: t('cherryPickTitle'),
                  description: t('cherryPickDesc', { subject: target.entry.subject }),
                  confirmLabel: t('cherryPickCommit'),
                  onConfirm: () => api.gitCherryPick(scope, target.entry.hashFull),
                })
              }
            }}
            portal
            align="start"
            getAnchorRect={() => (historyMenu === null ? null : new DOMRect(historyMenu.x, historyMenu.y, 0, 0))}
            anchor={<span />}
          />

          {/* Destructive actions land here first: Cancel / Confirm. */}
          <Modal
            open={confirm !== null}
            onClose={() => { setConfirm(null) }}
            title={confirm?.title ?? ''}
            closeLabel={t('cancel')}
            footer={(
              <>
                <Button variant="outline" onClick={() => { setConfirm(null) }}>{t('cancel')}</Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    const pending = confirm
                    if (pending === null) return
                    setConfirm(null)
                    void pending.onConfirm()
                  }}
                >
                  {confirm?.confirmLabel ?? ''}
                </Button>
              </>
            )}
          >
            <p className={css.gitConfirmDesc}>{confirm?.description}</p>
          </Modal>
        </>
      )}
    </div>
  )
}
