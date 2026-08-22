import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const EXPECTED_UPSTREAM_HANDLERS = [
  'handleAvailability',
  'handleCreateFlowPayment',
  'handleFlowConfirmation',
  'handlePaymentStatus'
];

function maskNonCode(source) {
  const chars = source.split('');
  let state = 'code';
  let escaped = false;

  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];

    if (state === 'code') {
      if (current === '/' && next === '/') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        state = 'line-comment';
      } else if (current === '/' && next === '*') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        state = 'block-comment';
      } else if (current === "'" || current === '"' || current === '`') {
        chars[index] = ' ';
        state = current === '`' ? 'template' : current;
        escaped = false;
      }
      continue;
    }

    if (state === 'line-comment') {
      if (current === '\n' || current === '\r') state = 'code';
      else chars[index] = ' ';
      continue;
    }

    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' ';
      }
      continue;
    }

    if (escaped) {
      if (current !== '\n' && current !== '\r') chars[index] = ' ';
      escaped = false;
    } else if (current === '\\') {
      chars[index] = ' ';
      escaped = true;
    } else if (current === (state === 'template' ? '`' : state)) {
      chars[index] = ' ';
      state = 'code';
    } else if (current !== '\n' && current !== '\r') {
      chars[index] = ' ';
    }
  }

  return chars.join('');
}

function findMatchingBrace(source, openingIndex) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findNamedFunctions(maskedSource) {
  const functions = [];
  const declaration = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let match;

  while ((match = declaration.exec(maskedSource)) !== null) {
    const openingBrace = declaration.lastIndex - 1;
    const closingBrace = findMatchingBrace(maskedSource, openingBrace);
    if (closingBrace === -1) throw new Error(`unclosed function body: ${match[1]}`);
    functions.push({
      name: match[1],
      start: openingBrace + 1,
      end: closingBrace
    });
    declaration.lastIndex = closingBrace + 1;
  }

  return functions;
}

export function assertNonprodUpstreamCallSites(source) {
  const maskedSource = maskNonCode(source);
  const functions = findNamedFunctions(maskedSource);
  const calls = [];
  const callPattern = /\bnonprodUpstream\s*\(\s*env\s*\)/g;
  let match;

  while ((match = callPattern.exec(maskedSource)) !== null) {
    if (/\bfunction\s+$/.test(maskedSource.slice(0, match.index))) continue;
    const containing = functions
      .filter((candidate) => match.index >= candidate.start && match.index < candidate.end)
      .sort((left, right) => (left.end - left.start) - (right.end - right.start));
    if (containing.length !== 1) {
      throw new Error(`upstream call is not inside exactly one named handler at offset ${match.index}`);
    }
    calls.push({ handler: containing[0].name, offset: match.index });
  }

  const actualHandlers = new Set(calls.map((call) => call.handler));
  const expectedHandlers = new Set(EXPECTED_UPSTREAM_HANDLERS);
  for (const handler of EXPECTED_UPSTREAM_HANDLERS) {
    const handlerCalls = calls.filter((call) => call.handler === handler);
    if (handlerCalls.length !== 1) {
      throw new Error(`${handler} must contain exactly one nonprodUpstream(env) call; found ${handlerCalls.length}`);
    }
  }
  for (const handler of actualHandlers) {
    if (!expectedHandlers.has(handler)) {
      throw new Error(`unauthorized handler invokes nonprodUpstream(env): ${handler}`);
    }
  }

  return calls;
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedAsScript) {
  const workerPath = process.argv[2];
  if (!workerPath) throw new Error('usage: assert-nonprod-worker-structure.mjs <worker-path>');
  const source = await readFile(workerPath, 'utf8');
  assertNonprodUpstreamCallSites(source);
  console.log('NONPROD_UPSTREAM_CALL_SITES=PASS');
}
