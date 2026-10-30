import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../lib/api';
import { useSession } from '../lib/session';
import type { Attachment, Comment, Issue, IssueStatus, User } from '../lib/types';
import { ISSUE_CATEGORY, ISSUE_STATUS, ISSUE_TYPE, SEVERITY, formatWaiting } from '@shared/domain.js';
import { FILE_GLYPH, MAX_UPLOAD_BYTES, fileKind, formatBytes, isInlineType } from '@shared/files.js';
import { Badge, Button, InlineSelect, Timestamp, localDate, relativeTime, type Tone } from './ui';

/** Mirrors the server-side transition table so the UI never offers a rejected move. */
const ALLOWED_TRANSITIONS: Record<string, IssueStatus[]> = {
  admin: Object.keys(ISSUE_STATUS) as IssueStatus[],
  dev: ['open', 'in_progress', 'blocked', 'ready_for_qa', 'wont_fix'],
  partner: ['open', 'blocked', 'verified', 'wont_fix'],
};

/** States anyone may drive an issue through once it is theirs. */
const WORKING_STATES: IssueStatus[] = ['open', 'in_progress', 'blocked', 'ready_for_qa'];

/** The single obvious next step per role, surfaced as a button next to the dropdown. */
function primaryAction(status: IssueStatus, role: string, mine = false): { next: IssueStatus; label: string } | null {
  // An issue on your own desk reads the same whoever you work for.
  if (role === 'partner' && mine) {
    if (status === 'open') return { next: 'in_progress', label: 'Start working' };
    if (status === 'in_progress') return { next: 'ready_for_qa', label: 'Done - hand it back' };
    if (status === 'blocked') return { next: 'in_progress', label: 'Unblocked - pick it back up' };
  }
  if (role === 'partner') {
    if (status === 'ready_for_qa') return { next: 'verified', label: 'Verified - close it' };
    if (status === 'verified') return { next: 'open', label: 'Reopen' };
    if (status === 'blocked') return { next: 'open', label: 'Unblocked - back to open' };
    return null;
  }
  if (status === 'blocked') return { next: 'in_progress', label: 'Unblocked - pick it back up' };
  if (status === 'open') return { next: 'in_progress', label: 'Start working' };
  if (status === 'in_progress') return { next: 'ready_for_qa', label: 'Fixed - ask for re-check' };
  if (status === 'ready_for_qa' && role === 'admin') return { next: 'verified', label: 'Verify' };
  return null;
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.8 6.8v4.4M9.2 6.8v4.4" strokeLinecap="round" />
    </svg>
  );
}

export default function IssueCard({
  issue: initial,
  users,
  showDomain = false,
  defaultOpen = false,
  onChanged,
}: {
  issue: Issue;
  users: User[];
  showDomain?: boolean;
  defaultOpen?: boolean;
  onChanged?: (issue: Issue) => void;
}) {
  const { user } = useSession();
  const [issue, setIssue] = useState(initial);
  const [open, setOpen] = useState(defaultOpen);
  const [detail, setDetail] = useState<{ comments: Comment[]; attachments: Attachment[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => setIssue(initial), [initial]);

  useEffect(() => {
    if (!open || detail) return;
    setLoading(true);
    api
      .get<{ comments: Comment[]; attachments: Attachment[] }>(`/issues/${issue.id}`)
      .then((r) => setDetail({ comments: r.comments, attachments: r.attachments }))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [open, detail, issue.id]);

  async function remove() {
    setError('');
    try {
      const { issue: saved } = await api.del<{ issue: Issue }>(`/issues/${issue.id}`);
      const merged = { ...issue, ...saved };
      setIssue(merged);
      setConfirmDelete(false);
      onChanged?.(merged);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the issue');
    }
  }

  async function restore() {
    setError('');
    try {
      const { issue: saved } = await api.post<{ issue: Issue }>(`/issues/${issue.id}/restore`);
      const merged = { ...issue, ...saved };
      setIssue(merged);
      onChanged?.(merged);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restore the issue');
    }
  }

  async function update(patch: Partial<Issue>) {
    setError('');
    try {
      // The version we last saw travels with the change, so a simultaneous edit
      // by somebody else is reported instead of silently overwritten.
      const { issue: saved } = await api.patch<{ issue: Issue }>(`/issues/${issue.id}`, {
        ...patch,
        expected_updated_at: issue.updated_at,
      });
      const merged = { ...issue, ...saved };
      setIssue(merged);
      onChanged?.(merged);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.payload?.issue) {
        // Show what is actually stored rather than what we hoped for.
        const fresh = { ...issue, ...(err.payload.issue as Issue) };
        setIssue(fresh);
        onChanged?.(fresh);
      }
      setError(err instanceof Error ? err.message : 'Could not save the change');
    }
  }

  const status = ISSUE_STATUS[issue.status] as { label: string; tone: Tone };
  const severity = SEVERITY[issue.severity] as { label: string; tone: Tone };
  const type = ISSUE_TYPE[issue.type] as { label: string; tone: Tone };
  const action = user ? primaryAction(issue.status, user.role, issue.assignee_id != null && issue.assignee_id === user.id) : null;
  /*
   * The reader's own calendar date. Comparing against the UTC date flipped an
   * issue to overdue up to a day early or late depending on the zone, while the
   * date itself was picked from a local-calendar date input.
   */
  const overdue = Boolean(issue.due_date) && !ISSUE_STATUS[issue.status].terminal && issue.due_date! < localDate();
  /*
   * Mirrors the server: whoever the issue is assigned to can move it through
   * the working states, whatever company they are at. Role still governs what
   * you may do to somebody else's work.
   */
  const mine = issue.assignee_id != null && issue.assignee_id === user?.id;
  const available = new Set([...(ALLOWED_TRANSITIONS[user?.role ?? 'partner'] ?? []), ...(mine ? WORKING_STATES : [])]);
  // In the order the loop runs, not the order the two lists were merged in.
  const statusOptions = (Object.keys(ISSUE_STATUS) as IssueStatus[])
    .filter((value) => available.has(value))
    .map((value) => ({ value, label: ISSUE_STATUS[value].label }));
  const issueAttachments = detail?.attachments.filter((a) => a.comment_id == null) ?? [];

  const deleted = Boolean(issue.deleted_at);
  const canDelete = user?.role === 'admin' || issue.reporter_id === user?.id;
  const canRestore = canDelete || issue.deleted_by === user?.id;

  return (
    <div
      className={`card overflow-hidden ${deleted ? 'opacity-70' : issue.status === 'open' ? 'border-l-2 border-l-tone-red' : ''}`}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
        <button onClick={() => setOpen(!open)} className="mt-0.5 shrink-0 text-ink-faint hover:text-ink" aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? '▾' : '▸'}
        </button>

        {/*
         * The minimum width is what lets the controls on the right drop to their
         * own line on a phone. Without it this column shrank to nothing and the
         * title came out one letter per line.
         */}
        <div className="min-w-[14rem] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {deleted && <Badge tone="muted">Deleted</Badge>}
            <Badge tone={status.tone}>{status.label}</Badge>
            <Badge tone={type.tone}>{type.label}</Badge>
            <Badge tone={severity.tone}>{severity.label}</Badge>
            {issue.site_id == null ? (
              <Badge tone="purple" title="Applies to the whole network, ticked off once">
                Network-wide
              </Badge>
            ) : (
              showDomain &&
              issue.domain && (
                <Link to={`/sites/${issue.site_id}`} className="text-xs font-medium text-ink-soft hover:text-brand hover:underline">
                  {issue.domain}
                </Link>
              )
            )}
            {issue.batch_id && (
              <Link to={`/issues?status=all&batch_id=${issue.batch_id}`} className="text-xs text-ink-faint hover:text-brand" title="Same finding across several domains">
                ⧉ batch
              </Link>
            )}
          </div>

          <button
            onClick={() => setOpen(!open)}
            className={`mt-1 block text-left text-sm font-medium [overflow-wrap:anywhere] hover:text-brand ${
              deleted ? 'line-through decoration-1' : ''
            }`}
          >
            {issue.title}
          </button>

          {issue.status === 'blocked' && (
            <p className="mt-1 text-xs text-tone-purple">
              Blocked on <span className="font-medium">{issue.blocked_on || 'someone outside the team'}</span>
              {issue.blocked_since && ` ${formatWaiting(issue.blocked_since)}`}
            </p>
          )}

          {/*
            * The page the defect is on, one click from the issue. Without it
            * every QA check and every fix cost three navigations - domain link,
            * site page, test URL, back.
            */}
          {issue.test_url && (
            <a
              href={issue.test_url}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 inline-flex max-w-full items-center gap-1 text-xs text-brand hover:underline"
              title={issue.test_url}
            >
              <span className="truncate">Open test page ↗</span>
            </a>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-faint">
            {/* The permalink page holds the full audit trail and the sibling
                issues of a batch, and nothing used to link to it. */}
            <Link to={`/issues/${issue.id}`} className="hover:text-brand hover:underline" title="Open this issue on its own page">
              #{issue.id}
            </Link>
            <span>{ISSUE_CATEGORY[issue.category as keyof typeof ISSUE_CATEGORY] ?? issue.category}</span>
            <span>
              Raised by <span className="text-ink-soft">{issue.reporter_name ?? 'unknown'}</span> · <Timestamp iso={issue.created_at} />
            </span>
            {issue.assignee_name && <span>Assigned to <span className="text-ink-soft">{issue.assignee_name}</span></span>}
            {issue.due_date && (
              <span className={overdue ? 'font-medium text-tone-red' : ''}>
                {overdue ? 'Overdue since' : 'Due'} {issue.due_date}
              </span>
            )}
            {(issue.qa_rounds ?? 0) > 1 && (
              <span className="text-tone-amber" title="How often this went back to the partner for a re-check">
                QA round {issue.qa_rounds}
              </span>
            )}
            {(issue.comment_count ?? 0) > 0 && !open && <span>💬 {issue.comment_count}</span>}
            {deleted ? (
              <span className="text-ink-soft">
                Deleted by {issue.deleted_by_name ?? 'someone'} <Timestamp iso={issue.deleted_at!} />
              </span>
            ) : (
              <span>Updated {relativeTime(issue.updated_at)}</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {deleted ? (
            canRestore && (
              <Button size="sm" onClick={restore}>
                Restore
              </Button>
            )
          ) : confirmDelete ? (
            /* The confirmation replaces the controls, so there is nothing to
               mis-click while it is up. */
            <>
              <span className="text-xs text-ink-soft">Delete? It stays in the history and can be restored.</span>
              <Button size="sm" variant="danger" onClick={remove}>
                Yes, delete
              </Button>
              <Button size="sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <InlineSelect
                value={issue.status}
                options={statusOptions}
                tone={status.tone}
                disabled={statusOptions.length === 0}
                onChange={(next) => update({ status: next })}
              />
              {action && (
                <Button size="sm" variant="primary" onClick={() => update({ status: action.next })}>
                  {action.label}
                </Button>
              )}
              {canDelete && (
                <button
                  onClick={() => setConfirmDelete(true)}
                  title="Delete this issue"
                  aria-label={`Delete issue ${issue.id}`}
                  className="rounded-lg px-2 py-1.5 text-ink-faint transition hover:bg-tone-red-bg hover:text-tone-red"
                >
                  <TrashIcon />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {error && <p className="mx-4 mb-3 rounded-lg bg-tone-red-bg px-3 py-2 text-xs text-tone-red">{error}</p>}

      {open && (
        <div className="space-y-4 border-t border-line bg-raised/40 px-4 py-4">
          {issue.description && (
            <p className="text-sm whitespace-pre-wrap text-ink-soft [overflow-wrap:anywhere]">{issue.description}</p>
          )}

          {!deleted && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-ink-faint">Assignee</span>
              <select
                className="field !w-auto !py-1 text-xs"
                value={issue.assignee_id ?? ''}
                onChange={(event) => update({ assignee_id: event.target.value ? Number(event.target.value) : null })}
              >
                <option value="">Unassigned</option>
                {/* The company is part of the name here: two of them share this list. */}
                {users.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                    {candidate.company ? ` (${candidate.company})` : ''}
                  </option>
                ))}
                {/*
                  * The list holds active people only, so an issue left with a
                  * since-disabled assignee had no matching option: the header
                  * said "Assigned to X" while the dropdown right below it read
                  * "Unassigned". Keeping the name here makes the mismatch
                  * visible and reassignable.
                  */}
                {issue.assignee_id != null && !users.some((candidate) => candidate.id === issue.assignee_id) && (
                  <option value={issue.assignee_id}>{issue.assignee_name ?? 'Unknown user'} (disabled)</option>
                )}
              </select>
              <span className="ml-2 text-ink-faint">Due</span>
              <input
                type="date"
                className="field !w-auto !py-1 text-xs"
                value={issue.due_date ?? ''}
                onChange={(event) => update({ due_date: event.target.value || null })}
              />
            </div>
          )}

          {issue.status === 'blocked' && (
            <div className="rounded-lg border border-tone-purple/30 bg-tone-purple-bg/40 px-3 py-2">
              <label className="block text-xs">
                <span className="text-ink-soft">Waiting on</span>
                <input
                  className="field mt-1 text-sm"
                  placeholder="TheMoneytizer contract, Google MCM approval, the client's own dev..."
                  defaultValue={issue.blocked_on ?? ''}
                  key={issue.blocked_on}
                  onBlur={(event) => {
                    if (event.target.value.trim() !== (issue.blocked_on ?? '')) update({ blocked_on: event.target.value.trim() });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
              </label>
              {issue.blocked_since && (
                <p className="mt-1.5 text-xs text-ink-faint">
                  Blocked {formatWaiting(issue.blocked_since)} - since <Timestamp iso={issue.blocked_since} />
                </p>
              )}
            </div>
          )}

          {loading && <p className="text-xs text-ink-faint">Loading conversation...</p>}

          {deleted && (
            <p className="text-xs text-ink-faint">
              This issue is deleted. Restore it to comment or attach anything.
            </p>
          )}

          {issueAttachments.length > 0 && <Gallery attachments={issueAttachments} onDeleted={reloadDetail} />}

          {detail && !deleted && (
            <Thread
              issueId={issue.id}
              comments={detail.comments}
              attachments={detail.attachments}
              onPosted={(comment, uploaded, fresh) => {
                setDetail({
                  comments: [...detail.comments, comment],
                  attachments: [...detail.attachments, ...uploaded],
                });
                /*
                 * `fresh` carries the issue's new updated_at. Without it the
                 * card kept the value from before the comment and the next
                 * status change came back as a 409 blaming a colleague.
                 */
                const merged = { ...issue, ...(fresh ?? {}), comment_count: (issue.comment_count ?? 0) + 1 };
                setIssue(merged);
                onChanged?.(merged);
              }}
              onDeleted={reloadDetail}
            />
          )}
        </div>
      )}
    </div>
  );

  function reloadDetail() {
    api
      .get<{ comments: Comment[]; attachments: Attachment[] }>(`/issues/${issue.id}`)
      .then((r) => setDetail({ comments: r.comments, attachments: r.attachments }));
  }
}

function Gallery({ attachments, onDeleted }: { attachments: Attachment[]; onDeleted: () => void }) {
  const { user } = useSession();
  const [zoom, setZoom] = useState<Attachment | null>(null);

  // Pictures are worth showing; a log file or an ads.txt snippet is worth
  // downloading, so the two get different treatment in the same list.
  const images = attachments.filter((a) => isInlineType(a.mime));
  const files = attachments.filter((a) => !isInlineType(a.mime));

  function canRemove(attachment: Attachment) {
    return user?.role === 'admin' || user?.id === attachment.uploader_id;
  }

  async function remove(attachment: Attachment) {
    await api.del(`/issues/attachments/${attachment.id}`);
    onDeleted();
  }

  return (
    <>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((attachment) => (
            <figure key={attachment.id} className="group relative">
              <button onClick={() => setZoom(attachment)} className="block">
                <img
                  src={`/api/issues/attachments/${attachment.id}/raw`}
                  alt={attachment.filename}
                  loading="lazy"
                  className="size-24 rounded-lg border border-line object-cover transition group-hover:brightness-95"
                />
              </button>
              {canRemove(attachment) && (
                <button
                  onClick={() => remove(attachment)}
                  className="absolute -top-1.5 -right-1.5 hidden size-5 place-items-center rounded-full bg-tone-red text-xs text-white group-hover:grid"
                  title="Delete image"
                  aria-label={`Delete ${attachment.filename}`}
                >
                  ✕
                </button>
              )}
              <figcaption className="mt-1 w-24 truncate text-[11px] text-ink-faint" title={attachment.filename}>
                {attachment.filename}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <ul className={`flex flex-wrap gap-2 ${images.length > 0 ? 'mt-2' : ''}`}>
          {files.map((attachment) => (
            <li key={attachment.id} className="group flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5">
              <span aria-hidden className="text-base leading-none">
                {FILE_GLYPH[fileKind(attachment.mime, attachment.filename) as keyof typeof FILE_GLYPH] ?? FILE_GLYPH.file}
              </span>
              <a
                href={`/api/issues/attachments/${attachment.id}/raw`}
                download={attachment.filename}
                className="min-w-0 truncate text-xs font-medium hover:text-brand hover:underline"
                title={`${attachment.filename} - download`}
              >
                {attachment.filename}
              </a>
              <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">{formatBytes(attachment.size)}</span>
              {canRemove(attachment) && (
                <button
                  onClick={() => remove(attachment)}
                  className="shrink-0 text-ink-faint transition hover:text-tone-red"
                  title="Delete file"
                  aria-label={`Delete ${attachment.filename}`}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {zoom && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6" onClick={() => setZoom(null)}>
          <img src={`/api/issues/attachments/${zoom.id}/raw`} alt={zoom.filename} className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </>
  );
}

function Thread({
  issueId,
  comments,
  attachments,
  onPosted,
  onDeleted,
}: {
  issueId: number;
  comments: Comment[];
  attachments: Attachment[];
  onPosted: (comment: Comment, uploaded: Attachment[], fresh?: Partial<Issue>) => void;
  onDeleted: () => void;
}) {
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim() && files.length === 0) return;

    const tooBig = files.find((file) => file.size > MAX_UPLOAD_BYTES);
    if (tooBig) {
      setError(`${tooBig.name} is ${formatBytes(tooBig.size)} - the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      return;
    }

    setBusy(true);
    setError('');
    try {
      const posted = await api.post<{ comment: Comment; issue?: Issue }>(`/issues/${issueId}/comments`, {
        body: body.trim() || '(attachment only)',
      });
      const { comment } = posted;
      // The last write wins for the concurrency token: an upload bumps it again.
      let fresh: Issue | undefined = posted.issue;

      const uploaded: Attachment[] = [];
      for (const file of files) {
        const result = await uploadAttachment(issueId, file, comment.id);
        uploaded.push(result.attachment);
        if (result.issue) fresh = result.issue;
      }
      onPosted(comment, uploaded, fresh);
      setBody('');
      setFiles([]);
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post the comment');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {comments.map((comment) => {
        const images = attachments.filter((a) => a.comment_id === comment.id);
        return (
          <article key={comment.id} className="rounded-lg border border-line bg-surface px-3 py-2">
            <header className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="font-medium">{comment.author_name ?? 'Deleted user'}</span>
              {comment.author_role && (
                <Badge tone={comment.author_role === 'partner' ? 'purple' : 'slate'}>
                  {comment.author_role === 'partner' ? 'Partner' : comment.author_role === 'admin' ? 'Admin' : 'Dev'}
                </Badge>
              )}
              <Timestamp iso={comment.created_at} className="text-ink-faint" />
            </header>
            <p className="mt-1 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{comment.body}</p>
            {images.length > 0 && (
              <div className="mt-2">
                <Gallery attachments={images} onDeleted={onDeleted} />
              </div>
            )}
          </article>
        );
      })}

      {comments.length === 0 && <p className="text-xs text-ink-faint">No comments yet.</p>}

      <form onSubmit={submit} className="space-y-2 rounded-lg border border-line bg-surface p-3">
        <textarea
          className="field min-h-20"
          placeholder="Add a comment - what you changed, what still fails, what you need..."
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            onChange={(event) => setFiles([...(event.target.files ?? [])])}
            className="text-xs text-ink-soft file:mr-2 file:rounded-lg file:border file:border-line-strong file:bg-raised file:px-2 file:py-1 file:text-xs"
          />
          {files.length > 0 && <span className="text-xs text-ink-faint">{files.length} file(s) attached</span>}
          <Button type="submit" size="sm" variant="primary" className="ml-auto" disabled={busy || (!body.trim() && files.length === 0)}>
            {busy ? 'Posting...' : 'Comment'}
          </Button>
        </div>
        {error && <p className="text-xs text-tone-red">{error}</p>}
      </form>
    </div>
  );
}

/**
 * One request per file: the raw bytes are the body, the name rides in a header.
 * Any type goes - screenshots, but also ads.txt snippets, tag exports and logs.
 */
export async function uploadAttachment(
  issueId: number,
  file: File,
  commentId?: number
): Promise<{ attachment: Attachment; issue?: Issue }> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${file.name} is ${formatBytes(file.size)} - the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`);
  }

  const query = commentId ? `?comment_id=${commentId}` : '';
  const response = await fetch(`/api/issues/${issueId}/attachments${query}`, {
    method: 'POST',
    credentials: 'same-origin',
    // A browser leaves file.type empty for extensions it does not know.
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Upload failed for ${file.name}`);
  return { attachment: payload.attachment as Attachment, issue: payload.issue as Issue | undefined };
}
