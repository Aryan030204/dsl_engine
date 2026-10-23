import { useMemo, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { Mail, Search, X, Trash2, UserPlus, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, PageSpinner } from '../components/ui';
import {
  useEmailRecipients,
  useEmailRecipient,
  useEmailConfigWorkflows,
  useUpdateEmailPreferences,
  useSetEmailMute,
  useChangeEmailWorkflows,
} from '../api/hooks';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const errorText = (error, fallback) => error?.response?.data?.error || error?.message || fallback;

const ACTION_LABELS = {
  preferences_updated: 'Changed settings',
  workflow_muted: 'Muted a workflow',
  workflow_unmuted: 'Unmuted a workflow',
  added_to_workflow: 'Added to a workflow',
  removed_from_workflow: 'Removed from a workflow',
};

function describeEvent(event) {
  const label = ACTION_LABELS[event.action] || event.action;
  const detail = event.details?.workflow ? `: ${event.details.workflow}` : '';
  return `${label}${detail}`;
}

const tenantLabel = (workflow) => {
  if (workflow.scope === 'global') return 'Global';
  if (workflow.tenantIds?.length) return workflow.tenantIds.join(', ');
  return workflow.tenantId || 'No tenant';
};

function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50',
        checked ? 'bg-primary-600' : 'bg-gray-300'
      )}
    >
      <span className={clsx('inline-block h-4 w-4 transform rounded-full bg-white transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

function StatusBadges({ person }) {
  const pausedNow = person.paused && (!person.pausedUntil || new Date(person.pausedUntil) > new Date());
  return (
    <div className="flex flex-wrap gap-1">
      {pausedNow && (
        <Badge className="bg-amber-100 text-amber-800">
          Paused{person.pausedUntil ? ` until ${format(new Date(person.pausedUntil), 'MMM d')}` : ''}
        </Badge>
      )}
      {person.severityMin === 'CRITICAL' && <Badge className="bg-red-100 text-red-800">Critical only</Badge>}
      {person.mutedCount > 0 && <Badge className="bg-gray-100 text-gray-700">{person.mutedCount} muted</Badge>}
      {!pausedNow && person.severityMin !== 'CRITICAL' && !person.mutedCount && (
        <span className="text-xs text-gray-400">Receives everything</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- one person

function RecipientPanel({ email, onClose }) {
  const { data, isLoading, error } = useEmailRecipient(email);
  const updatePreferences = useUpdateEmailPreferences();
  const setMute = useSetEmailMute();
  const changeWorkflows = useChangeEmailWorkflows();
  const [resumeOn, setResumeOn] = useState('');
  const [toAdd, setToAdd] = useState('');

  const grouped = useMemo(() => {
    const groups = new Map();
    (data?.workflows || []).forEach((workflow) => {
      const label = tenantLabel(workflow);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(workflow);
    });
    return [...groups.entries()];
  }, [data]);

  const save = async (patch, success) => {
    try {
      await updatePreferences.mutateAsync({ email, patch });
      toast.success(success);
    } catch (err) {
      toast.error(errorText(err, 'Could not save'));
    }
  };

  const preferences = data?.preferences;
  const pausedNow = preferences?.paused && (!preferences.pausedUntil || new Date(preferences.pausedUntil) > new Date());

  const toggleMute = async (workflow, receiving) => {
    try {
      await setMute.mutateAsync({ email, workflowKey: workflow.key, muted: !receiving });
      toast.success(receiving ? `${email} will receive "${workflow.name}" again` : `Muted "${workflow.name}" for ${email}`);
    } catch (err) {
      toast.error(errorText(err, 'Could not save'));
    }
  };

  const change = async ({ add = [], remove = [] }, success) => {
    try {
      const results = await changeWorkflows.mutateAsync({ email, add, remove });
      const failed = results.filter((result) => result.error);
      if (failed.length) toast.error(`${failed[0].name || 'Workflow'}: ${failed[0].error}`);
      else toast.success(success);
    } catch (err) {
      toast.error(errorText(err, 'Could not save'));
    }
  };

  const remove = (workflow) => {
    if (!window.confirm(`Remove ${email} from "${workflow.name}"?\n\nThis saves a new version of the workflow.`)) return;
    change({ remove: [workflow.key] }, `Removed from "${workflow.name}"`);
  };

  const add = async () => {
    if (!toAdd) return;
    const workflow = data.availableWorkflows.find((item) => item.key === toAdd);
    await change({ add: [toAdd] }, `Added to "${workflow?.name || 'workflow'}"`);
    setToAdd('');
  };

  return (
    <Card className="lg:sticky lg:top-6">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate">{data?.name || email}</CardTitle>
            {data?.name && <p className="text-sm text-gray-500 truncate">{email}</p>}
            {data && !data.isAppUser && <Badge className="mt-1 bg-slate-100 text-slate-700">External address</Badge>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-gray-100 text-gray-500">
            <X className="w-5 h-5" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading && <p className="text-sm text-gray-500">Loading...</p>}
        {error && <p className="text-sm text-red-600">{errorText(error, 'Could not load this person')}</p>}

        {data && (
          <>
            {/* Settings */}
            <section>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Settings</h3>
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-gray-800">Pause all emails</p>
                      <p className="text-xs text-gray-500">Nothing is sent to this person while paused (for example on leave).</p>
                    </div>
                    <Switch
                      checked={Boolean(pausedNow)}
                      label="Pause all emails"
                      disabled={updatePreferences.isPending}
                      onChange={(next) => save(
                        { paused: next, ...(next && resumeOn ? { pausedUntil: new Date(resumeOn).toISOString() } : {}) },
                        next ? 'Emails paused' : 'Emails resumed'
                      )}
                    />
                  </div>
                  {pausedNow ? (
                    <p className="text-xs text-amber-700 mt-2">
                      {preferences.pausedUntil
                        ? `Paused until ${format(new Date(preferences.pausedUntil), 'MMM d, yyyy HH:mm')}.`
                        : 'Paused until you resume.'}
                    </p>
                  ) : (
                    <div className="mt-2 flex items-center gap-2">
                      <label className="text-xs text-gray-500" htmlFor="resume-on">Resume on (optional)</label>
                      <input
                        id="resume-on"
                        type="datetime-local"
                        value={resumeOn}
                        onChange={(e) => setResumeOn(e.target.value)}
                        className="border border-gray-300 rounded-lg px-2 py-1 text-xs"
                      />
                      <span className="text-xs text-gray-400">set before switching pause on</span>
                    </div>
                  )}
                </div>

                <div>
                  <p className="text-sm font-medium text-gray-800">Which alerts</p>
                  <p className="text-xs text-gray-500 mb-2">Applies to alert-state workflows. Daily reports are not filtered by severity.</p>
                  <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                    {[['TRIGGERED', 'All alerts'], ['CRITICAL', 'Critical only']].map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        disabled={updatePreferences.isPending}
                        onClick={() => preferences.severityMin !== value && save({ severityMin: value }, `Now receives: ${label.toLowerCase()}`)}
                        className={clsx(
                          'px-3 py-1.5 text-sm',
                          preferences.severityMin === value ? 'bg-primary-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {/* Workflows */}
            <section>
              <h3 className="text-sm font-semibold text-gray-900 mb-1">Workflows ({data.workflows.length})</h3>
              <p className="text-xs text-gray-500 mb-3">
                Switch a workflow off to stop its emails for this person without removing them. Removing saves a new workflow version.
              </p>
              {!data.workflows.length && <p className="text-sm text-gray-500">Not on any workflow yet.</p>}
              <div className="space-y-4">
                {grouped.map(([label, workflows]) => (
                  <div key={label}>
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">{label}</p>
                    <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
                      {workflows.map((workflow) => (
                        <li key={workflow.key} className="flex items-center gap-3 px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <p className={clsx('text-sm truncate', workflow.muted ? 'text-gray-400 line-through' : 'text-gray-900')}>{workflow.name}</p>
                            <p className="text-xs text-gray-500">
                              {workflow.alertState ? 'Alert state' : workflow.purpose === 'daily_insight' ? 'Daily report' : 'Sends every run'}
                              {' · '}{workflow.nodes.length} email {workflow.nodes.length === 1 ? 'step' : 'steps'}
                            </p>
                          </div>
                          <Switch
                            checked={!workflow.muted}
                            label={`Receive ${workflow.name}`}
                            disabled={setMute.isPending}
                            onChange={(receiving) => toggleMute(workflow, receiving)}
                          />
                          <button
                            type="button"
                            onClick={() => remove(workflow)}
                            disabled={changeWorkflows.isPending}
                            title="Remove from this workflow"
                            className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex items-center gap-2">
                <select
                  value={toAdd}
                  onChange={(e) => setToAdd(e.target.value)}
                  className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  aria-label="Add to workflow"
                >
                  <option value="">Add to a workflow...</option>
                  {data.availableWorkflows.map((workflow) => (
                    <option key={workflow.key} value={workflow.key}>{tenantLabel(workflow)}: {workflow.name}</option>
                  ))}
                </select>
                <Button size="sm" onClick={add} disabled={!toAdd} loading={changeWorkflows.isPending}>
                  <Plus className="w-4 h-4 mr-1" /> Add
                </Button>
              </div>
            </section>

            {/* Recent changes */}
            <section>
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Recent changes</h3>
              {!data.events.length && <p className="text-sm text-gray-500">No changes yet.</p>}
              <ul className="space-y-1.5">
                {data.events.slice(0, 8).map((event, index) => (
                  <li key={`${event.at}-${index}`} className="text-xs text-gray-600">
                    <span className="text-gray-900">{describeEvent(event)}</span>
                    <span className="text-gray-400"> · {event.by || 'unknown'} · {formatDistanceToNow(new Date(event.at), { addSuffix: true })}</span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- People tab

function PeopleTab({ search, selected, onSelect }) {
  const { data: people = [], isLoading, error } = useEmailRecipients();
  const [newEmail, setNewEmail] = useState('');

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return people;
    return people.filter((person) => `${person.email} ${person.name || ''}`.toLowerCase().includes(term));
  }, [people, search]);

  const addPerson = () => {
    const value = newEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      toast.error('Enter a valid email address');
      return;
    }
    onSelect(value);
    setNewEmail('');
  };

  if (isLoading) return <PageSpinner />;
  if (error) return <p className="text-sm text-red-600">{errorText(error, 'Could not load people')}</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addPerson()}
          placeholder="Set up an address that is not listed (name@company.com)"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
        <Button size="sm" variant="secondary" onClick={addPerson}>
          <UserPlus className="w-4 h-4 mr-1" /> Open
        </Button>
      </div>

      {!filtered.length ? (
        <EmptyState title="No one matches" description="Try a different search." />
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Person</th>
                <th className="px-4 py-2 text-center">Workflows</th>
                <th className="px-4 py-2 hidden md:table-cell">Brands</th>
                <th className="px-4 py-2">Settings</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((person) => (
                <tr
                  key={person.email}
                  onClick={() => onSelect(person.email)}
                  className={clsx('cursor-pointer hover:bg-gray-50', selected === person.email && 'bg-primary-50')}
                >
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-gray-900">{person.name || person.email}</p>
                    {person.name && <p className="text-xs text-gray-500">{person.email}</p>}
                    {!person.isAppUser && <span className="text-xs text-slate-500">External</span>}
                  </td>
                  <td className="px-4 py-2.5 text-center text-gray-800">{person.workflowCount}</td>
                  <td className="px-4 py-2.5 hidden md:table-cell text-xs text-gray-600">
                    {person.tenants.slice(0, 4).join(', ')}{person.tenants.length > 4 ? ` +${person.tenants.length - 4}` : ''}
                  </td>
                  <td className="px-4 py-2.5"><StatusBadges person={person} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- By workflow tab

function WorkflowRow({ workflow, peopleEmails, onOpenPerson }) {
  const changeWorkflows = useChangeEmailWorkflows();
  const [email, setEmail] = useState('');

  const addPerson = async () => {
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      toast.error('Enter a valid email address');
      return;
    }
    try {
      const [result] = await changeWorkflows.mutateAsync({ email: value, add: [workflow.key], remove: [] });
      if (result?.error) toast.error(result.error);
      else {
        toast.success(`Added ${value}`);
        setEmail('');
      }
    } catch (err) {
      toast.error(errorText(err, 'Could not add'));
    }
  };

  const removePerson = async (person) => {
    if (!window.confirm(`Remove ${person.email} from "${workflow.name}"?\n\nThis saves a new version of the workflow.`)) return;
    try {
      const [result] = await changeWorkflows.mutateAsync({ email: person.email, add: [], remove: [workflow.key] });
      if (result?.error) toast.error(result.error);
      else toast.success(`Removed ${person.email}`);
    } catch (err) {
      toast.error(errorText(err, 'Could not remove'));
    }
  };

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium text-gray-900">{workflow.name}</p>
        {workflow.alertState && <Badge className="bg-sky-100 text-sky-800">Alert state</Badge>}
        {workflow.purpose === 'daily_insight' && <Badge status="daily_insight">Daily report</Badge>}
        <span className="text-xs text-gray-400">v{workflow.version}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {!workflow.recipients.length && <span className="text-xs text-gray-400">No email recipients</span>}
        {workflow.recipients.map((person) => (
          <span
            key={person.email}
            className={clsx(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs',
              person.muted || person.paused ? 'border-gray-200 bg-gray-50 text-gray-400' : 'border-gray-300 bg-white text-gray-800'
            )}
          >
            <button type="button" onClick={() => onOpenPerson(person.email)} className="hover:underline">{person.name || person.email}</button>
            {person.muted && <span title="Muted for this workflow">(muted)</span>}
            {person.paused && <span title="All emails paused">(paused)</span>}
            {person.severityMin === 'CRITICAL' && <span title="Critical alerts only">(critical)</span>}
            <button type="button" onClick={() => removePerson(person)} title="Remove from workflow" className="text-gray-400 hover:text-red-600">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          list="email-config-people"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addPerson()}
          placeholder="Add a person (email)"
          className="w-64 max-w-full border border-gray-300 rounded-lg px-2.5 py-1 text-xs"
        />
        <Button size="sm" variant="secondary" onClick={addPerson} loading={changeWorkflows.isPending} disabled={!email}>Add</Button>
      </div>
      <datalist id="email-config-people">
        {peopleEmails.map((value) => <option key={value} value={value} />)}
      </datalist>
    </li>
  );
}

function WorkflowsTab({ search, onOpenPerson }) {
  const { data: workflows = [], isLoading, error } = useEmailConfigWorkflows();
  const { data: people = [] } = useEmailRecipients();
  const peopleEmails = useMemo(() => people.map((person) => person.email), [people]);

  const grouped = useMemo(() => {
    const term = search.trim().toLowerCase();
    const groups = new Map();
    workflows
      .filter((workflow) => !term
        || workflow.name.toLowerCase().includes(term)
        || workflow.recipients.some((person) => person.email.includes(term) || (person.name || '').toLowerCase().includes(term)))
      .forEach((workflow) => {
        const label = tenantLabel(workflow);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(workflow);
      });
    return [...groups.entries()];
  }, [workflows, search]);

  if (isLoading) return <PageSpinner />;
  if (error) return <p className="text-sm text-red-600">{errorText(error, 'Could not load workflows')}</p>;
  if (!grouped.length) return <EmptyState title="No workflows match" description="Try a different search." />;

  return (
    <div className="space-y-5">
      {grouped.map(([label, items]) => (
        <div key={label}>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">{label}</p>
          <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg bg-white">
            {items.map((workflow) => (
              <WorkflowRow key={workflow.key} workflow={workflow} peopleEmails={peopleEmails} onOpenPerson={onOpenPerson} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function EmailConfigurationsPage() {
  const [tab, setTab] = useState('people');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);

  const openPerson = (email) => {
    setTab('people');
    setSelected(email);
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Mail className="w-6 h-6 text-primary-600" />
          <h1 className="text-2xl font-bold text-gray-900">Email Configurations</h1>
        </div>
        <p className="text-sm text-gray-600 mt-1">
          Who receives which workflow's emails, and each person's own settings. Pausing or muting stops the email for that person only;
          they stay on the workflow.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
          {[['people', 'People'], ['workflows', 'By workflow']].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={clsx('px-4 py-2 text-sm font-medium', tab === value ? 'bg-primary-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tab === 'people' ? 'Search people' : 'Search workflows or people'}
            className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm"
          />
        </div>
      </div>

      {tab === 'people' ? (
        <div className={clsx('grid gap-6 items-start', selected ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]' : 'grid-cols-1')}>
          <PeopleTab search={search} selected={selected} onSelect={setSelected} />
          {selected && <RecipientPanel key={selected} email={selected} onClose={() => setSelected(null)} />}
        </div>
      ) : (
        <WorkflowsTab search={search} onOpenPerson={openPerson} />
      )}
    </div>
  );
}
