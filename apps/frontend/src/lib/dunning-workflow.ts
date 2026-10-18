// Pure dunning workflow helpers (#190). No imports, so the Node test runner can load this file directly.

export type DunningStepType =
  | "polite_reminder"
  | "urgent_notice"
  | "grace_discount"
  | "recovery_link"
  | "final_attempt";

export interface DunningStep {
  day: number;
  retry_pull: boolean;
  step_type: DunningStepType;
  grace_discount_pct?: number;
  email_subject: string;
  email_body: string;
}

export interface RecoveryFunnel {
  failed_invoices: number;
  recovered_invoices: number;
  exhausted_invoices: number;
  failed_volume: string;
  recovered_volume: string;
  net_churn_prevented_count: number;
  net_churn_prevented_volume: string;
  recovery_rate: number;
}

export const MAX_DUNNING_DAY = 30;
export const MAX_DUNNING_STEPS = 10;

export const STEP_TYPE_LABELS: Record<DunningStepType, string> = {
  polite_reminder: "Polite reminder",
  urgent_notice: "Urgent notice",
  grace_discount: "Grace discount",
  recovery_link: "Recovery payment link",
  final_attempt: "Final attempt (cancels on failure)",
};

export const PLACEHOLDERS = [
  "merchant_name",
  "plan_name",
  "amount",
  "customer_wallet",
  "recovery_url",
  "day",
  "discount_pct",
] as const;

// Mirrors the backend default: Day 1 / 3 / 5 / 7.
export const DEFAULT_DUNNING_STEPS: DunningStep[] = [
  {
    day: 1,
    retry_pull: true,
    step_type: "polite_reminder",
    email_subject: "Your {{plan_name}} payment failed",
    email_body:
      "Hi, we could not process your payment of {{amount}} for {{plan_name}}. We will retry automatically. You can also pay now: {{recovery_url}}",
  },
  {
    day: 3,
    retry_pull: true,
    step_type: "urgent_notice",
    email_subject: "Action needed: {{plan_name}} payment still failing",
    email_body:
      "Your {{plan_name}} subscription is still past due. Please update your payment method today: {{recovery_url}}",
  },
  {
    day: 5,
    retry_pull: true,
    step_type: "grace_discount",
    grace_discount_pct: 10,
    email_subject: "A 10% grace discount on {{plan_name}}",
    email_body:
      "Pay within the next two days and receive {{discount_pct}}% off your outstanding balance: {{recovery_url}}",
  },
  {
    day: 7,
    retry_pull: true,
    step_type: "final_attempt",
    email_subject: "Final notice for {{plan_name}}",
    email_body:
      "This is our final attempt to collect your payment. If it fails, your subscription will be cancelled.",
  },
];

const SAMPLE_VARIABLES: Record<string, string> = {
  merchant_name: "Acme Studio",
  plan_name: "Pro Monthly",
  amount: "29.00 USDC",
  customer_wallet: "GABC...XYZ",
  recovery_url: "https://useorbit.xyz/pay/plan?recovery=true",
  day: "3",
  discount_pct: "10",
};

export function findUnknownPlaceholders(text: string): string[] {
  const found = [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]);
  const known = new Set<string>(PLACEHOLDERS);
  return [...new Set(found.filter((key) => !known.has(key)))];
}

/** Replaces `{{name}}` placeholders. Unknown placeholders stay as written. */
export function renderDunningTemplate(
  text: string,
  variables: Record<string, string | number | undefined> = SAMPLE_VARIABLES,
): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(key)) return match;
    const value = variables[key];
    return value === undefined || value === null ? match : String(value);
  });
}

/** Returns the problems with a workflow. An empty array means it can be saved. */
export function validateDunningSteps(steps: DunningStep[]): string[] {
  const errors: string[] = [];
  if (steps.length === 0) errors.push("Add at least one step.");
  if (steps.length > MAX_DUNNING_STEPS) errors.push(`Use at most ${MAX_DUNNING_STEPS} steps.`);

  steps.forEach((step, index) => {
    if (!Number.isInteger(step.day) || step.day < 1 || step.day > MAX_DUNNING_DAY) {
      errors.push(`Step ${index + 1} must run between day 1 and day ${MAX_DUNNING_DAY}.`);
    }
    if (index > 0 && step.day <= steps[index - 1].day) {
      errors.push(`Step ${index + 1} must run after step ${index}.`);
    }
    if (step.step_type === "grace_discount") {
      const pct = step.grace_discount_pct;
      if (pct === undefined || !Number.isFinite(pct) || pct < 0 || pct > 100) {
        errors.push(`Step ${index + 1} needs a grace discount between 0% and 100%.`);
      }
    }
    if (!step.email_subject.trim()) errors.push(`Step ${index + 1} needs an email subject.`);
    if (!step.email_body.trim()) errors.push(`Step ${index + 1} needs an email body.`);
    for (const field of [step.email_subject, step.email_body]) {
      const unknown = findUnknownPlaceholders(field);
      if (unknown.length) errors.push(`Step ${index + 1} uses unknown placeholder(s): ${unknown.join(", ")}.`);
    }
  });

  const last = steps[steps.length - 1];
  if (last && last.step_type !== "final_attempt") {
    errors.push("The last step must be a final attempt. It cancels the subscription if the payment fails.");
  }
  return errors;
}

export function addDunningStep(steps: DunningStep[]): DunningStep[] {
  if (steps.length >= MAX_DUNNING_STEPS) return steps;
  const lastDay = steps.length ? steps[steps.length - 1].day : 0;
  const day = Math.min(MAX_DUNNING_DAY, lastDay + 1);
  // Insert before the final attempt, so the workflow still ends with it
  const newStep: DunningStep = {
    day,
    retry_pull: true,
    step_type: "urgent_notice",
    email_subject: "Payment reminder for {{plan_name}}",
    email_body: "Your payment for {{plan_name}} is still outstanding: {{recovery_url}}",
  };
  const finalIndex = steps.length - 1;
  if (finalIndex >= 0 && steps[finalIndex].step_type === "final_attempt") {
    return [...steps.slice(0, finalIndex), newStep, steps[finalIndex]];
  }
  return [...steps, newStep];
}

export function updateDunningStep(steps: DunningStep[], index: number, patch: Partial<DunningStep>): DunningStep[] {
  return steps.map((step, i) => (i === index ? { ...step, ...patch } : step));
}

export function removeDunningStep(steps: DunningStep[], index: number): DunningStep[] {
  if (steps.length <= 1) return steps;
  return steps.filter((_, i) => i !== index);
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Renders the small markdown subset merchants use in reminder copy (**bold**,
 * *italic*, line breaks). The text is escaped first, so the output is safe to
 * place in innerHTML.
 */
export function markdownPreviewHtml(markdown: string): string {
  const escaped = escapeHtml(markdown);
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br />");
}

/** Formats a raw USDC amount (7 decimals, as a string) for display. */
export function formatRawUsdc(raw: string): string {
  const value = Number(raw) / 10_000_000;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
