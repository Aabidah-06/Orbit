import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderSafeMarkdown} from '../src/lib/template-markdown.ts';
test('template preview substitutes variables and escapes active HTML',()=>{const html=renderSafeMarkdown('**Paid {{amount}}** <script>alert(1)</script>',{amount:'29 USDC'});assert.match(html,/<strong>Paid 29 USDC<\/strong>/);assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));});
