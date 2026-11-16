import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Site } from '../lib/types';
import { Button, Modal } from './ui';

/** "X" typed into a Prio field: take the site out of the network. */
export const isRemoveCommand = (raw: string) => /^\s*x\s*$/i.test(raw);

/** The line a removed site's row carries instead of its columns. */
export function removedLine(site: Pick<Site, 'removed_reason'>) {
  return `REMOVED FROM NETWORK DUE: ${withoutPrefix(site.removed_reason ?? '') || 'no reason given'}`;
}

/** The line already starts with the words; typed (or pasted) into the reason too, they showed twice. */
export const withoutPrefix = (reason: string) => reason.replace(/^(\s*removed from (the )?network( due)?\s*:?\s*)+/i, '').trim();

/**
 * Prio "X": asks why before the site leaves the network. Sent again for a site
 * that is already out, it edits the reason. A number typed into Prio later
 * brings the site back (the server clears the reason then).
 */
export function RemoveFromNetworkModal({
  site,
  onClose,
  onRemoved,
}: {
  site: Site;
  onClose: () => void;
  onRemoved: (site: Site) => void;
}) {
  const editing = Boolean(site.removed_reason);
  const [reason, setReason] = useState(withoutPrefix(site.removed_reason ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  // The dialog focuses its first control, the close button; the reason is what has to be typed.
  useEffect(() => {
    const timer = setTimeout(() => box.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!reason.trim()) return setError('Say why the site leaves the network.');
    setBusy(true);
    setError('');
    try {
      const { site: saved } = await api.patch<{ site: Site }>(`/sites/${site.id}`, { removed_reason: withoutPrefix(reason) || reason.trim() });
      onRemoved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? `Why ${site.domain} was removed` : `Remove ${site.domain} from the network`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        {!editing && (
          <p className="text-ink-soft">
            Prio <span className="font-semibold text-ink">X</span>: the site moves to the bottom of the list, below prio 99,
            and its row shows only the prio, the domain and the reason. It no longer counts in the rollout numbers. Its
            history, issues and discussion stay. To bring it back, type a number into Prio.
          </p>
        )}
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-soft">Reason</span>
          <textarea
            ref={box}
            className="field min-h-20"
            maxLength={500}
            required
            placeholder="e.g. traffic quality too low, publisher ended the contract..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {reason.trim() && (
          <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-xs font-semibold tracking-wide text-tone-red" title="How the row will read">
            {removedLine({ removed_reason: reason })}
          </p>
        )}
        {error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-tone-red">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
            {busy ? 'Saving...' : editing ? 'Save reason' : 'Remove from network'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
