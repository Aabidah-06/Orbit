import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DUNNING_STEPS,
  addDunningStep,
  findUnknownPlaceholders,
  formatRawUsdc,
  markdownPreviewHtml,
  removeDunningStep,
  renderDunningTemplate,
  updateDunningStep,
  validateDunningSteps,
} from '../src/lib/dunning-workflow.ts';

test('the default workflow is Day 1, 3, 5, 7 and ends with a final attempt', () => {
  assert.deepEqual(DEFAULT_DUNNING_STEPS.map((s) => s.day), [1, 3, 5, 7]);
  assert.equal(DEFAULT_DUNNING_STEPS[2].grace_discount_pct, 10);
  assert.equal(DEFAULT_DUNNING_STEPS.at(-1).step_type, 'final_attempt');
  assert.deepEqual(validateDunningSteps(DEFAULT_DUNNING_STEPS), []);
});

test('validation enforces increasing days, discount range, placeholders and a final attempt', () => {
  const steps = updateDunningStep(DEFAULT_DUNNING_STEPS, 1, { day: 1 });
  assert.ok(validateDunningSteps(steps).some((m) => m.includes('must run after step 1')));

  const badDiscount = updateDunningStep(DEFAULT_DUNNING_STEPS, 2, { grace_discount_pct: 140 });
  assert.ok(validateDunningSteps(badDiscount).some((m) => m.includes('grace discount')));

  const badPlaceholder = updateDunningStep(DEFAULT_DUNNING_STEPS, 0, { email_body: 'Pay {{card_number}}' });
  assert.ok(validateDunningSteps(badPlaceholder).some((m) => m.includes('card_number')));

  const noFinal = updateDunningStep(DEFAULT_DUNNING_STEPS, 3, { step_type: 'urgent_notice' });
  assert.ok(validateDunningSteps(noFinal).some((m) => m.includes('final attempt')));
});

test('adding a step keeps the final attempt last; removing never empties the workflow', () => {
  const added = addDunningStep(DEFAULT_DUNNING_STEPS);
  assert.equal(added.length, 5);
  assert.equal(added.at(-1).step_type, 'final_attempt');
  assert.deepEqual(validateDunningSteps(added), []);

  assert.equal(removeDunningStep([DEFAULT_DUNNING_STEPS[0]], 0).length, 1);
});

test('placeholders render when known and stay visible when unknown', () => {
  const rendered = renderDunningTemplate('{{plan_name}} owes {{amount}} {{mystery}}', { plan_name: 'Pro', amount: '29.00 USDC' });
  assert.equal(rendered, 'Pro owes 29.00 USDC {{mystery}}');
  assert.deepEqual(findUnknownPlaceholders('{{plan_name}} {{mystery}} {{mystery}}'), ['mystery']);
});

test('the markdown preview escapes HTML before applying formatting', () => {
  const html = markdownPreviewHtml('**Hi** <img src=x onerror=alert(1)>\nSee you');
  assert.equal(html, '<strong>Hi</strong> &lt;img src=x onerror=alert(1)&gt;<br />See you');
  assert.ok(!html.includes('<img'));
});

test('raw USDC amounts format from 7-decimal units', () => {
  assert.equal(formatRawUsdc('290000000'), '$29.00');
  assert.equal(formatRawUsdc('1234567890000'), '$123,456.79');
});
