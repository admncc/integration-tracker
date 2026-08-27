export type Role = 'admin' | 'dev' | 'partner';

export interface User {
  id: number;
  username: string;
  email: string | null;
  name: string;
  role: Role;
  company: string;
  active?: number;
}

export type TrackStatus = 'live' | 'qa' | 'tag_impl' | 'tag_prep' | 'pending' | 'na';
export type CmpValue = 'none' | 'old' | 'new';
export type ApprovalValue = 'none' | 'sent' | 'approved' | 'rejected';
export type IssueStatus = 'open' | 'in_progress' | 'blocked' | 'ready_for_qa' | 'verified' | 'wont_fix';
export type Severity = 'blocker' | 'high' | 'medium' | 'low';
export type IssueType = 'technical' | 'revenue';
export type Currency = 'EUR' | 'USD';

export interface Site {
  id: number;
  domain: string;
  priority: number;
  test_url: string;
  status_video: TrackStatus;
  status_display: TrackStatus;
  status_ads_txt: TrackStatus;
  status_ad_tag: TrackStatus;
  status_mcm: TrackStatus;
  cmp: CmpValue;
  approval: ApprovalValue;
  rpm_previous: number | null;
  rpm_previous_currency: Currency;
  rpm_primis: number | null;
  rpm_primis_currency: Currency;
  managed_by: string;
  /** Who is answerable for this domain. Null means nobody has taken it on. */
  owner_id: number | null;
  owner_name?: string | null;
  owner_company?: string | null;
  owner_role?: Role | null;
  notes: string;
  archived: number;
  created_at: string;
  updated_at: string;
  open_issues?: number;
  awaiting_qa?: number;
  blocked_issues?: number;
  total_issues?: number;
  message_count?: number;
}

export interface SiteMessage {
  id: number;
  site_id: number;
  author_id: number | null;
  author_name: string | null;
  author_role: Role | null;
  reply_to_id: number | null;
  reply_to_body: string | null;
  reply_to_author: string | null;
  reply_to_deleted_at: string | null;
  body: string;
  created_at: string;
  deleted_at: string | null;
}

export interface Issue {
  id: number;
  /** null for a network-wide issue: it belongs to no single domain. */
  site_id: number | null;
  batch_id: number | null;
  title: string;
  description: string;
  type: IssueType;
  category: string;
  severity: Severity;
  status: IssueStatus;
  reporter_id: number | null;
  assignee_id: number | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  domain?: string;
  test_url?: string;
  site_priority?: number;
  reporter_name?: string | null;
  assignee_name?: string | null;
  batch_title?: string | null;
  comment_count?: number;
  qa_rounds?: number;
  deleted_at: string | null;
  deleted_by: number | null;
  deleted_by_name?: string | null;
  /** Only meaningful while status is `blocked`: who the work waits on. */
  blocked_on?: string;
  blocked_since?: string | null;
}

/** One line of "it is your turn", derived server-side from the current state. */
export interface InboxItem {
  key: string;
  n: number;
  label: string;
  to: string;
}

export interface Inbox {
  items: InboxItem[];
  total: number;
  blocked: number;
  open: number;
}

export interface Comment {
  id: number;
  issue_id: number;
  author_id: number | null;
  author_name: string | null;
  author_role: Role | null;
  body: string;
  created_at: string;
}

export interface ActivityEntry {
  id: number;
  site_id: number | null;
  issue_id: number | null;
  actor_name: string | null;
  domain?: string | null;
  issue_title?: string | null;
  kind: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

export interface Stats {
  totals: { sites: number; fully_live: number; inactive: number; open_issues: number; awaiting_qa: number; verified: number; blocked: number };
  trackBreakdown: Record<string, { label: string; counts: { status: TrackStatus; n: number }[] }>;
  issuesByStatus: { status: IssueStatus; n: number }[];
  issuesByType: { type: IssueType; n: number }[];
  issuesBySeverity: { severity: Severity; n: number }[];
  issuesByCategory: { category: string; n: number }[];
  hotSites: { id: number; domain: string; priority: number; open_issues: number }[];
  revenue: {
    with_figures: number;
    better: number | null;
    worse: number | null;
    avg_previous: number | null;
    avg_primis: number | null;
    missing: number;
    eur_usd: number;
    worst: RpmRow[];
    best: RpmRow[];
  };
  recent: ActivityEntry[];
  blockedIssues: { id: number; title: string; blocked_on: string; blocked_since: string | null; domain: string | null; site_id: number | null }[];
}

export interface Attachment {
  id: number;
  issue_id: number;
  comment_id: number | null;
  uploader_id: number | null;
  filename: string;
  mime: string;
  size: number;
  created_at: string;
  uploader_name: string | null;
}

export interface RpmRow {
  id: number;
  domain: string;
  rpm_previous: number;
  rpm_previous_currency: Currency;
  rpm_primis: number;
  rpm_primis_currency: Currency;
  previous_base: number;
  primis_base: number;
  uplift: number;
}
