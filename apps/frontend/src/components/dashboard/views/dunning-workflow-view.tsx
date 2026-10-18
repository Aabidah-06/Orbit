"use client";

import { useEffect, useMemo, useState } from "react";
import { ORBIT_API_URL, merchantRequestHeaders } from "@/lib/api";
import {
  DEFAULT_DUNNING_STEPS,
  MAX_DUNNING_DAY,
  MAX_DUNNING_STEPS,
  PLACEHOLDERS,
  STEP_TYPE_LABELS,
  DunningStep,
  DunningStepType,
  RecoveryFunnel,
  addDunningStep,
  formatRawUsdc,
  markdownPreviewHtml,
  removeDunningStep,
  renderDunningTemplate,
  updateDunningStep,
  validateDunningSteps,
} from "@/lib/dunning-workflow";

interface WorkflowResponse {
  steps: DunningStep[];
  is_default: boolean;
  updated_at: string | null;
}

const STEP_TYPES = Object.keys(STEP_TYPE_LABELS) as DunningStepType[];

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // fall through to the fallback
  }
  return `${fallback} (${res.status})`;
}

export default function DunningWorkflowView() {
  const [steps, setSteps] = useState<DunningStep[]>(DEFAULT_DUNNING_STEPS);
  const [savedSteps, setSavedSteps] = useState<DunningStep[]>(DEFAULT_DUNNING_STEPS);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [funnel, setFunnel] = useState<RecoveryFunnel | null>(null);
  const [funnelError, setFunnelError] = useState("");

  const validationErrors = useMemo(() => validateDunningSteps(steps), [steps]);
  const dirty = JSON.stringify(steps) !== JSON.stringify(savedSteps);
  const active = steps[selected] ?? steps[0];

  useEffect(() => {
    let cancelled = false;
    const headers = merchantRequestHeaders();

    fetch(`${ORBIT_API_URL}/dunning/workflow`, { headers })
      .then((res) => (res.ok ? (res.json() as Promise<WorkflowResponse>) : Promise.reject(new Error("Could not load the dunning workflow."))))
      .then((data) => {
        if (cancelled) return;
        setSteps(data.steps);
        setSavedSteps(data.steps);
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    fetch(`${ORBIT_API_URL}/dunning/analytics`, { headers })
      .then((res) => (res.ok ? (res.json() as Promise<{ funnel: RecoveryFunnel }>) : Promise.reject(new Error("Could not load recovery analytics."))))
      .then((data) => {
        if (!cancelled) setFunnel(data.funnel);
      })
      .catch((reason: Error) => {
        if (!cancelled) setFunnelError(reason.message);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (validationErrors.length) {
      setError(validationErrors[0]);
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${ORBIT_API_URL}/dunning/workflow`, {
        method: "PUT",
        headers: merchantRequestHeaders(),
        body: JSON.stringify({ steps }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not save the workflow."));
      const data = (await res.json()) as WorkflowResponse;
      setSteps(data.steps);
      setSavedSteps(data.steps);
      setNotice("Workflow saved. New failed payments follow this schedule.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the workflow.");
    } finally {
      setSaving(false);
    }
  };

  const patchActive = (patch: Partial<DunningStep>) => {
    setSteps((current) => updateDunningStep(current, selected, patch));
  };

  const insertPlaceholder = (key: string) => {
    patchActive({ email_body: `${active.email_body} {{${key}}}` });
  };

  const addStep = () => {
    const next = addDunningStep(steps);
    setSteps(next);
    setSelected(Math.min(next.length - 1, selected + 1));
  };

  const removeStep = () => {
    const next = removeDunningStep(steps, selected);
    setSteps(next);
    setSelected(Math.max(0, Math.min(selected, next.length - 1)));
  };

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading dunning workflow...</p>;
  }

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-xl font-semibold">Dunning workflow</h2>
        <p className="text-sm text-neutral-500">
          Set the retry days and the reminder copy for failed subscription payments. Placeholders are filled in for each customer.
        </p>
      </header>

      {/* Timeline */}
      <section aria-label="Recovery timeline" className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Recovery timeline</h3>
          <div className="flex gap-2">
            <button type="button" onClick={addStep} disabled={steps.length >= MAX_DUNNING_STEPS} className="rounded border px-3 py-1 text-sm disabled:opacity-50">
              Add step
            </button>
            <button type="button" onClick={removeStep} disabled={steps.length <= 1} className="rounded border px-3 py-1 text-sm disabled:opacity-50">
              Remove step
            </button>
          </div>
        </div>
        <ol className="flex flex-wrap gap-3">
          {steps.map((step, index) => (
            <li key={`${index}-${step.day}`}>
              <button
                type="button"
                onClick={() => setSelected(index)}
                aria-pressed={selected === index}
                className={`min-w-[10rem] rounded-lg border p-3 text-left text-sm ${selected === index ? "border-indigo-500 ring-1 ring-indigo-500" : "border-neutral-300"}`}
              >
                <span className="block font-semibold">Day {step.day}</span>
                <span className="block">{STEP_TYPE_LABELS[step.step_type]}</span>
                <span className="block text-xs text-neutral-500">
                  {step.retry_pull ? "Retries pull" : "No retry"}
                  {step.step_type === "grace_discount" && step.grace_discount_pct !== undefined ? ` · ${step.grace_discount_pct}% off` : ""}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      {/* Step editor with live preview */}
      <section aria-label="Step editor" className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <h3 className="text-sm font-semibold">Step {selected + 1} settings</h3>

          <label className="block text-sm">
            Day
            <input
              type="number"
              min={1}
              max={MAX_DUNNING_DAY}
              value={active.day}
              onChange={(e) => patchActive({ day: Number(e.target.value) })}
              className="mt-1 w-full rounded border px-3 py-2"
            />
          </label>

          <label className="block text-sm">
            Action
            <select
              value={active.step_type}
              onChange={(e) => {
                const step_type = e.target.value as DunningStepType;
                patchActive({ step_type, grace_discount_pct: step_type === "grace_discount" ? active.grace_discount_pct ?? 10 : undefined });
              }}
              className="mt-1 w-full rounded border px-3 py-2"
            >
              {STEP_TYPES.map((type) => (
                <option key={type} value={type}>{STEP_TYPE_LABELS[type]}</option>
              ))}
            </select>
          </label>

          {active.step_type === "grace_discount" && (
            <label className="block text-sm">
              Grace discount (%)
              <input
                type="number"
                min={0}
                max={100}
                value={active.grace_discount_pct ?? ""}
                onChange={(e) => patchActive({ grace_discount_pct: Number(e.target.value) })}
                className="mt-1 w-full rounded border px-3 py-2"
              />
            </label>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={active.retry_pull} onChange={(e) => patchActive({ retry_pull: e.target.checked })} />
            Retry the pull on this day
          </label>

          <label className="block text-sm">
            Email subject
            <input
              value={active.email_subject}
              onChange={(e) => patchActive({ email_subject: e.target.value })}
              className="mt-1 w-full rounded border px-3 py-2"
            />
          </label>

          <label className="block text-sm">
            Email body (markdown)
            <textarea
              rows={6}
              value={active.email_body}
              onChange={(e) => patchActive({ email_body: e.target.value })}
              className="mt-1 w-full rounded border px-3 py-2 font-mono text-sm"
            />
          </label>

          <div className="flex flex-wrap gap-2" aria-label="Insert placeholder">
            {PLACEHOLDERS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => insertPlaceholder(key)}
                className="rounded-full border px-2 py-0.5 font-mono text-xs"
              >
                {`{{${key}}}`}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Preview</h3>
          <p className="text-xs text-neutral-500">{renderDunningTemplate(active.email_subject)}</p>
          <div
            className="rounded-lg border bg-white p-4 text-sm text-neutral-900"
            // Escaped by markdownPreviewHtml before rendering
            dangerouslySetInnerHTML={{ __html: markdownPreviewHtml(renderDunningTemplate(active.email_body)) }}
          />
        </div>
      </section>

      {/* Save */}
      <section aria-label="Save workflow" className="space-y-3">
        {validationErrors.length > 0 && (
          <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-red-600">
            {validationErrors.map((message) => <li key={message}>{message}</li>)}
          </ul>
        )}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save workflow"}
        </button>
      </section>

      {/* Recovery funnel */}
      <section aria-label="Recovery analytics" className="space-y-3">
        <h3 className="text-sm font-semibold">Recovery funnel</h3>
        {funnelError && <p role="alert" className="text-sm text-red-600">{funnelError}</p>}
        {funnel && (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Failed invoices" value={String(funnel.failed_invoices)} detail={formatRawUsdc(funnel.failed_volume)} />
            <Stat label="Recovered invoices" value={String(funnel.recovered_invoices)} detail={formatRawUsdc(funnel.recovered_volume)} />
            <Stat label="Net churn prevented" value={String(funnel.net_churn_prevented_count)} detail={formatRawUsdc(funnel.net_churn_prevented_volume)} />
            <Stat label="Recovery rate" value={`${Math.round(funnel.recovery_rate * 100)}%`} detail={`${funnel.exhausted_invoices} cancelled`} />
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-neutral-500">{detail}</p>
    </div>
  );
}
