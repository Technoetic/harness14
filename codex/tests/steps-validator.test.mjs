import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadIndex,
  recordSourceHashes,
  scanForbiddenTokens,
  validateIndex,
  validateStepBatch
} from "../scripts/validate-steps.mjs";
import { makeWorkspace } from "./helpers/workspace.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function entry(number, overrides = {}) {
  const id = `step${String(number).padStart(3, "0")}`;
  return {
    number,
    id,
    title: `Step ${number}`,
    phase: "preflight",
    source: `assets/steps/${id}.md`,
    target: `codex/assets/steps/${id}.md`,
    source_sha256: "a".repeat(64),
    ported: false,
    next: number === 50 ? null : `step${String(number + 1).padStart(3, "0")}`,
    ...overrides
  };
}

async function fixtureRoot() {
  // makeWorkspace() removes the folder when the test process exits.
  const root = await makeWorkspace();
  await mkdir(join(root, "assets", "steps"), { recursive: true });
  return root;
}

async function portedFixture({ acceptance, visualReview = false } = {}) {
  const root = await fixtureRoot();
  await mkdir(join(root, "codex", "assets", "steps"), { recursive: true });
  const steps = Array.from({ length: 50 }, (_, offset) => entry(offset + 1, {
    inputs: [],
    outputs: [],
    requires: [],
    optional_requires: [],
    network: false,
    visual_review: visualReview,
    acceptance: acceptance ?? [{
      id: "completion-check",
      kind: "check",
      required: true,
      description: "Records deterministic completion evidence."
    }],
    ported: true
  }));
  for (const step of steps) {
    await writeFile(join(root, step.source), `source ${step.number}\n`);
    await writeFile(join(root, step.target), "Use available capabilities.\n");
  }
  const hashes = await recordSourceHashes(root, steps);
  for (const step of steps) step.source_sha256 = hashes[step.id];
  return { root, index: { schema_version: 1, steps } };
}

function parseStepDocument(content) {
  const normalized = content.replaceAll("\r\n", "\n");
  const frontmatterMatch = /^---\n([^]*?)\n---(?:\n|$)/.exec(normalized);
  assert.ok(frontmatterMatch, "step document is missing frontmatter");
  const frontmatter = Object.fromEntries(frontmatterMatch[1].split("\n").map((line) => {
    const separator = line.indexOf(":");
    assert.notEqual(separator, -1, `invalid frontmatter line: ${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  const titleMatches = [...normalized.matchAll(/^# Step (\d+) - (.+)$/gm)];

  return {
    frontmatter,
    titles: titleMatches.map((match) => ({
      number: Number(match[1]),
      title: match[2]
    })),
    referencedSteps: [...normalized.matchAll(/\bStep\s+(\d+)\b/g)].map((match) => Number(match[1]))
  };
}

function extractMarkdownSection(content, heading) {
  const normalized = content.replaceAll("\r\n", "\n");
  const headings = [...normalized.matchAll(/^## ([^\n]+)$/gm)];
  const matches = headings.filter((match) => match[1] === heading);
  assert.equal(matches.length, 1, `expected exactly one ## ${heading} section`);
  const match = matches[0];
  const next = headings.find((candidate) => candidate.index > match.index);
  return normalized.slice(match.index + match[0].length, next?.index ?? normalized.length).trim();
}

function extractOrderedMarkdownSections(content, expectedHeadings) {
  const normalized = content.replaceAll("\r\n", "\n");
  const headings = [...normalized.matchAll(/^## ([^\n]+)$/gm)];
  const sections = {};
  let previousIndex = -1;

  for (const expectedHeading of expectedHeadings) {
    const matches = headings.filter((match) => match[1] === expectedHeading);
    assert.equal(matches.length, 1, `expected exactly one ## ${expectedHeading} section`);
    const match = matches[0];
    assert.ok(match.index > previousIndex, `## ${expectedHeading} is out of order`);
    const next = headings.find((candidate) => candidate.index > match.index);
    sections[expectedHeading] = normalized
      .slice(match.index + match[0].length, next?.index ?? normalized.length)
      .trim();
    previousIndex = match.index;
  }

  return sections;
}

function assertPlanningPermissionContract(content) {
  const roleSection = extractMarkdownSection(content, "실행 역할").replace(/\s+/g, " ");
  assert.match(roleSection, /정상 권한 확인을 유지/);
  assert.match(roleSection, /자동 승인이나 권한 우회를 금지/);

  assert.doesNotMatch(
    content,
    /(?:안전|일반|모든)(?:한)?\s*명령(?:은|을)?[^.\n]{0,120}자동\s*승인/i
  );
  assert.doesNotMatch(
    content,
    /권한\s*확인(?:\s*절차)?(?:을|를)?\s*우회/i
  );
  assert.doesNotMatch(
    content,
    /\bpermissionDecision\b["']?\s*(?::|=)\s*["']?(?:allow|ask)\b/i
  );
  assert.doesNotMatch(content, /\b(?:safe|ordinary|normal)\s+commands?[^.\n]{0,80}\bauto[- ]?approve/i);
  assert.doesNotMatch(content, /\bauto[- ]?approve[^.\n]{0,80}\b(?:safe|ordinary|normal)\s+commands?\b/i);
  assert.doesNotMatch(content, /\bbypass(?:ing)?\s+(?:the\s+)?permission\s+checks?\b/i);
  assert.doesNotMatch(content, /\bdangerously[-_ ]?bypass(?:[-_ ][a-z]+)*\b/i);
}

function assertStep30SectionContract(content) {
  const expectedOrder = [
    "주제와 기획 확인",
    "첫 설계 활동: 구조화된 대안 탐색",
    "독립 선택",
    "Class 설계 계약",
    "비동기와 성능 계약",
    "레이아웃·상호작용·접근성 계약",
    "시각 토큰·제외 계약",
    "최종 독립 검증",
    "완료 조건"
  ];
  const sections = extractOrderedMarkdownSections(content, expectedOrder);
  const goal = extractMarkdownSection(content, "목표").replace(/\s+/g, " ");
  const topic = sections["주제와 기획 확인"].replace(/\s+/g, " ");
  const exploration = sections["첫 설계 활동: 구조화된 대안 탐색"].replace(/\s+/g, " ");
  const selection = sections["독립 선택"].replace(/\s+/g, " ");
  const classDesign = sections["Class 설계 계약"].replace(/\s+/g, " ");
  const asyncDesign = sections["비동기와 성능 계약"].replace(/\s+/g, " ");
  const accessibility = sections["레이아웃·상호작용·접근성 계약"].replace(/\s+/g, " ");
  const contract = sections["시각 토큰·제외 계약"].replace(/\s+/g, " ");
  const verification = sections["최종 독립 검증"].replace(/\s+/g, " ");
  const completion = sections["완료 조건"].replace(/\s+/g, " ");

  assert.match(goal, /실제 구현이나 패키지 설치는 수행하지 않는다/);

  assert.match(topic, /가장 먼저 `step_archive\/TOPIC\/TOPIC\.md`/);
  assert.match(topic, /`topic`[^]*`audience`[^]*`interactive`[^]*`real_world_apps`[^]*`constraints`/);
  assert.match(topic, /29단계[^]*기획[^]*검증 보고서[^]*`PASS`/);

  assert.match(exploration, /첫 설계 활동은 구조화된 브레인스토밍과 대안 탐색/);
  assert.match(exploration, /외부 기능의 특정 이름[^]*의존하지 않는다/);
  assert.match(exploration, /사용자에게 옵션을 질문하지 않고[^]*주제 제약 안에서/);
  assert.match(exploration, /설계안 A[^]*설계안 B[^]*설계안 C/);
  assert.match(exploration, /레이아웃 구조[^]*아키텍처[^]*반응형 전략[^]*실질적으로 달라야/);
  assert.doesNotMatch(exploration, /\b(?:superpowers:|Skill\s*\(|skill\s*=|plugin:)/i);
  assert.doesNotMatch(exploration, /사용자에게[^.\n]{0,80}옵션(?:을)?\s*질문(?:한다|하라)/);

  assert.match(selection, /독립 선택자는 대안을 수정하지 않고 정확히 하나만 선택/);
  assert.match(selection, /유지보수성[^]*반응형 구현 난이도[^]*조사 적합성[^]*접근성/);
  assert.match(
    selection,
    /선택된 안만[^]*`step_archive\/step030_레이아웃설계_chunk1\.md`[^]*`step_archive\/step030_전체설계_chunk1\.md`/
  );

  assert.match(classDesign, /단일 책임[^]*합성[^]*생성자 주입[^]*전역 상태[^]*public[^]*private/i);
  assert.match(classDesign, /클래스 다이어그램[^]*의존 관계도[^]*public async 시그니처[^]*시퀀스 다이어그램[^]*라이프사이클/);

  assert.match(asyncDesign, /`async init\(\)`[^]*`async start\(\)`/);
  assert.match(asyncDesign, /I\/O[^]*DOM[^]*애니메이션[^]*취소[^]*오류[^]*병렬[^]*성능/);
  assert.match(asyncDesign, /부분 실패 복구/);

  for (const required of [/키보드/, /포커스/, /reduced-motion/i, /터치/, /(?:명암|contrast)/i]) {
    assert.match(accessibility, required);
  }
  assert.match(accessibility, /반응형 breakpoint[^]*화면 상태/);
  assert.match(accessibility, /loading[^]*empty[^]*error[^]*disabled/);

  assert.match(contract, /`step_archive\/step030_레이아웃설계_chunk1\.md`[^]*`json harness50-design-contract`[^]*정확히 하나/);
  assert.match(contract, /`docs\/DESIGN-CONTRACT\.md`/);
  assert.match(contract, /`tokens`[^]*`colors`[^]*`fonts`[^]*`type`[^]*`spacing`[^]*`radius`[^]*`shadow`[^]*`exclude`/);
  assert.match(contract, /`id`[^]*`source`[^]*`signature`[^]*`adopted`[^]*`exception_reason`/);
  assert.match(contract, /`host` 출처의 기본 항목을 두지 않는다/);
  assert.match(contract, /`generic-sans`[^]*`purple-gradient`[^]*`centered-cards`[^]*`excess-radius`[^]*`flat-background`/);
  assert.match(contract, /TOPIC `constraints`와 요청 전문[^]*`topic-1`/);
  assert.match(contract, /`adopted: true`[^]*`exception_reason`[^]*결정\/사유/);
  assert.match(contract, /`topic` 항목은 채택하지 않/);
  assert.match(contract, /계약이 우선/);
  assert.doesNotMatch(contract, /cream-background|italic-heading-accent|numbered-section-labels|monospace-labels|pill-buttons/);
  assert.match(verification, /시각 토큰·제외 계약/);
  const reportReferences = [...new Set(
    [...verification.matchAll(/`(step_archive\/outputs\/step030_최종검증(?:_r\d+)?\.md)`/g)]
      .map((match) => match[1])
  )];
  assert.deepEqual(reportReferences, ["step_archive/outputs/step030_최종검증.md"]);
  assert.match(verification, /동일한 선언 보고서[^]*라운드별 섹션[^]*최대 5라운드/);
  assert.match(verification, /`PASS`[^]*경우에만 완료/);
  assert.match(verification, /`FAIL`[^]*완료 증거가 될 수 없다/);
  assert.match(verification, /5라운드[^]*`PASS`[^]*없으면[^]*차단/);
  assert.doesNotMatch(verification, /최종검증_r[2-5]\.md|스킵[^]*(?:완료|종료)/);

  for (const acceptanceId of [
    "design-alternatives",
    "design-selection",
    "layout-design-chunk-1",
    "overall-design-chunk-1",
    "final-design-verification",
    "class-architecture-contract",
    "async-lifecycle-contract",
    "responsive-accessibility-contract",
    "design-exclusion-contract",
    "pass-verdict"
  ]) {
    assert.match(completion, new RegExp("`" + acceptanceId + "`"));
  }

  return sections;
}

const EXPECTED_PLANNING_ACCEPTANCE_DESCRIPTIONS = {
  step025: {
    "base-planning-snapshot": "Stores the topic-complete base planning snapshot with a bounded manifest.",
    "planning-verification-report": "Stores every bounded independent review round in one report.",
    "topic-fidelity": "Confirms every topic, audience, interaction, application, and constraint field is reflected.",
    "general-research-provenance": "Traces every factual claim and planning decision to persisted general-research evidence.",
    "planning-chunks-bounded": "Confirms the declared planning manifest matches a snapshot of at most 500 lines.",
    "bounded-independent-review": "Confirms an independent reviewer used no more than five evidence-first rounds.",
    "pass-verdict": "Requires a fully evidenced PASS; FAIL and skipped findings never satisfy completion."
  },
  step026: {
    "github-planning-snapshot": "Stores a complete planning snapshot enriched only by persisted GitHub evidence.",
    "github-planning-verification": "Stores every bounded independent GitHub-evidence review round in one report.",
    "persisted-github-response-only": "Confirms only persisted successful API responses or the verified exhausted-no-reference disposition supply candidates and facts.",
    "decision-provenance": "Confirms each decision has cited evidence, or a verified no-reference disposition produces an explicit empty decision set.",
    "planning-chunks-bounded": "Confirms the declared planning manifest matches a snapshot of at most 500 lines.",
    "bounded-independent-review": "Confirms an independent reviewer used no more than five evidence-first rounds.",
    "pass-verdict": "Requires a fully evidenced PASS; FAIL and skipped findings never satisfy completion."
  },
  step027: {
    "api-contract-planning-snapshot": "Stores a complete planning snapshot enriched by the persisted official API contract.",
    "api-contract-planning-verification": "Stores every bounded independent contract review round in one report.",
    "concrete-contract-provenance": "Traces the concrete subject, version, and every contract decision to the official source.",
    "schema-contract-completeness": "Confirms structures, fields, authentication, rates, errors, retries, and limits are covered without invention.",
    "planning-chunks-bounded": "Confirms the declared planning manifest matches a snapshot of at most 500 lines.",
    "bounded-independent-review": "Confirms an independent reviewer used no more than five evidence-first rounds.",
    "pass-verdict": "Requires a fully evidenced PASS; FAIL and skipped findings never satisfy completion."
  },
  step028: {
    "repository-planning-snapshot": "Stores a complete planning snapshot enriched by quarantined static repository evidence.",
    "repository-planning-verification": "Stores every bounded independent repository-evidence review round in one report.",
    "static-analysis-only": "Confirms cloned code was never executed, installed, built, tested, or automated.",
    "decision-provenance": "Confirms each decision has cited evidence, or a verified no-reference disposition produces an explicit empty decision set.",
    "planning-chunks-bounded": "Confirms the declared planning manifest matches a snapshot of at most 500 lines.",
    "bounded-independent-review": "Confirms an independent reviewer used no more than five evidence-first rounds.",
    "pass-verdict": "Requires a fully evidenced PASS; FAIL and skipped findings never satisfy completion."
  },
  step029: {
    "visual-planning-snapshot": "Stores the complete integrated visual and interaction planning snapshot.",
    "visual-planning-verification": "Stores every bounded independent visual-evidence review round in one report.",
    "planning-screenshot-input": "Requires the primary screenshot used during visual planning inspection.",
    "evidence-axis-fidelity": "Confirms only evidence-named axes and alternatives informed planning decisions.",
    "interaction-accessibility-contracts": "Confirms responsive, interaction, state, keyboard, focus, touch, motion, and contrast contracts.",
    "visual-evidence-inspection": "Confirms required screenshots were actually opened and compared with the capture manifest.",
    "planning-chunks-bounded": "Confirms the declared planning manifest matches a snapshot of at most 500 lines.",
    "bounded-independent-review": "Confirms an independent reviewer used no more than five evidence-first rounds.",
    "pass-verdict": "Requires a fully evidenced PASS; FAIL and skipped findings never satisfy completion."
  },
  step030: {
    "design-alternatives": "Stores three materially distinct layout, architecture, and responsive alternatives.",
    "design-selection": "Stores the independent selector's one evidence-based choice without modifying alternatives.",
    "layout-design-chunk-1": "Stores the bounded final layout and interaction design selected from the alternatives.",
    "overall-design-chunk-1": "Stores the bounded final class architecture and asynchronous design.",
    "final-design-verification": "Stores every bounded final independent verification round in one report.",
    "structured-brainstorming-first": "Confirms structured brainstorming and alternative exploration was the first design activity.",
    "independent-selector": "Confirms a separate selector chose exactly one alternative without editing it.",
    "class-architecture-contract": "Confirms SRP classes, composition, constructor injection, state ownership, and public/private APIs.",
    "async-lifecycle-contract": "Confirms asynchronous initialization, start, I/O, cancellation, errors, parallelism, and performance contracts.",
    "responsive-accessibility-contract": "Confirms responsive breakpoints, states, keyboard, focus, reduced motion, touch, and contrast contracts.",
    "design-exclusion-contract": "Confirms the layout design holds exactly one visual token and exclusion contract that merges the host default and TOPIC exclusions and records a reason for every adopted exception.",
    "design-chunks-bounded": "Confirms design manifests match declared chunks of at most 500 lines.",
    "pass-verdict": "Requires the final independent verifier to record an evidenced PASS."
  }
};

function assertPlanningAcceptanceDescriptions(steps) {
  const actual = Object.fromEntries(steps.map((step) => [
    step.id,
    Object.fromEntries(step.acceptance.map((item) => [item.id, item.description]))
  ]));
  assert.deepEqual(actual, EXPECTED_PLANNING_ACCEPTANCE_DESCRIPTIONS);
}

test("map covers every source step with canonical boundaries", async () => {
  const index = await loadIndex(repoRoot);
  const report = validateIndex(index, { repoRoot, requirePorted: false });

  assert.deepEqual(
    report.steps.map((step) => step.number),
    Array.from({ length: 50 }, (_, offset) => offset + 1)
  );
  assert.equal(report.steps[0].source, "assets/steps/step001.md");
  assert.equal(report.steps[0].target, "codex/assets/steps/step001.md");
  assert.equal(report.steps.at(-1).next, null);
  assert.ok(report.steps.every((step) => typeof step.ported === "boolean"));
});

test("index records SHA-256 digests of the unmodified Claude source bytes", async () => {
  const index = await loadIndex(repoRoot);
  const hashes = await recordSourceHashes(repoRoot, index.steps.slice(0, 5));

  assert.deepEqual(hashes, {
    step001: "6690075e5774aa3455ba4fb9c5c0497081f48fee22302923127533ed58314966",
    step002: "1dd9112ab7bf0aa3f72ec51794fb0bbc9144c88c14ae0b5bbc909ef7382f57ca",
    step003: "2bdcad6fb02b18b425a107d3d37d4c8f1e7098ebdc1764e83715daaf569e3633",
    step004: "f12500e805c8b69cc5c29955254a8e71fb244474d2d0d6ff61f333cc42180f9a",
    step005: "902d5a5ce9f8eaff9121b54ececc9206955c50326b7c86ad26965f9bd9d0339b"
  });
});

test("preflight batch declares the exact Codex-native step contracts", async () => {
  const report = await validateStepBatch(repoRoot, [1, 2, 3, 4, 5]);

  assert.deepEqual(report.steps, [
    {
      number: 1,
      id: "step001",
      title: "하네스 프리플라이트 체크",
      phase: "preflight",
      source: "assets/steps/step001.md",
      target: "codex/assets/steps/step001.md",
      source_sha256: "6690075e5774aa3455ba4fb9c5c0497081f48fee22302923127533ed58314966",
      inputs: ["step_archive/TOPIC/TOPIC.md"],
      outputs: ["step_archive/step001_preflight.md"],
      requires: [],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "topic-contract",
          kind: "artifact",
          required: true,
          description: "Verifies the existing immutable tutorial topic input has required fields and matches the stated topic and constraints without modification.",
          path: "step_archive/TOPIC/TOPIC.md"
        },
        {
          id: "preflight-report",
          kind: "artifact",
          required: true,
          description: "Records required and optional tool availability without storing secrets.",
          path: "step_archive/step001_preflight.md"
        },
        {
          id: "node-runtime-version",
          kind: "command",
          required: true,
          description: "Confirms that the Node.js runtime is available.",
          command: "node --version"
        },
        {
          id: "npm-cli-version",
          kind: "command",
          required: true,
          description: "Confirms that the npm CLI is available.",
          command: "npm --version"
        },
        {
          id: "required-tool-inventory",
          kind: "check",
          required: true,
          description: "Confirms every required tool is available after at most three permitted attempts; diagnostic failures never satisfy this acceptance."
        },
        {
          id: "optional-tool-disposition",
          kind: "check",
          required: true,
          description: "Records each optional tool as OK or an explicit safe SKIP with a reason."
        }
      ],
      ported: true,
      next: "step002"
    },
    {
      number: 2,
      id: "step002",
      title: "프로젝트 분석 및 Context 전략 수립",
      phase: "preflight",
      source: "assets/steps/step002.md",
      target: "codex/assets/steps/step002.md",
      source_sha256: "1dd9112ab7bf0aa3f72ec51794fb0bbc9144c88c14ae0b5bbc909ef7382f57ca",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step001_preflight.md"
      ],
      outputs: ["step_archive/step002_context전략_chunk1.md"],
      requires: ["step001"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        {
          id: "context-strategy-chunk-1",
          kind: "artifact",
          required: true,
          description: "Stores the first bounded context-strategy chunk and a manifest for any additional chunks.",
          path: "step_archive/step002_context전략_chunk1.md"
        },
        {
          id: "project-scale-recorded",
          kind: "check",
          required: true,
          description: "Records project scale, relevant file counts, and the largest relevant files."
        },
        {
          id: "context-chunks-bounded",
          kind: "check",
          required: true,
          description: "Confirms every declared context-strategy chunk is at most 500 lines."
        }
      ],
      ported: true,
      next: "step003"
    },
    {
      number: 3,
      id: "step003",
      title: "브라우저 자동화 환경 확인",
      phase: "preflight",
      source: "assets/steps/step003.md",
      target: "codex/assets/steps/step003.md",
      source_sha256: "2bdcad6fb02b18b425a107d3d37d4c8f1e7098ebdc1764e83715daaf569e3633",
      inputs: ["step_archive/step001_preflight.md"],
      outputs: [
        "step_archive/step003_playwright_test.md",
        "step_archive/screenshots/step003_playwright_smoke.png",
        "step_archive/outputs/browser-backend.json"
      ],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "browser-backend-probe",
          kind: "command",
          required: true,
          description: "Probes the validation checkout for an available browser backend (Playwright or Aside CLI) and succeeds only when one is selected.",
          command: "node scripts/verify-output.mjs --probe"
        },
        {
          id: "browser-backend-lock",
          kind: "artifact",
          required: true,
          description: "Stores the Step 3 browser backend lock (schema_version, selected, tool_version, probed_at) written by the probe with --lock.",
          path: "step_archive/outputs/browser-backend.json"
        },
        {
          id: "browser-smoke-screenshot",
          kind: "artifact",
          required: true,
          description: "Stores the blank-page smoke screenshot captured by the selected backend.",
          path: "step_archive/screenshots/step003_playwright_smoke.png"
        },
        {
          id: "browser-environment-report",
          kind: "artifact",
          required: true,
          description: "Records the probe result (backends, selected, tool_version) plus the smoke outcome.",
          path: "step_archive/step003_playwright_test.md"
        }
      ],
      ported: true,
      next: "step004"
    },
    {
      number: 4,
      id: "step004",
      title: "접근성 검사(axe) 환경 확인",
      phase: "preflight",
      source: "assets/steps/step004.md",
      target: "codex/assets/steps/step004.md",
      source_sha256: "f12500e805c8b69cc5c29955254a8e71fb244474d2d0d6ff61f333cc42180f9a",
      inputs: ["step_archive/step003_playwright_test.md"],
      outputs: ["step_archive/step004_axe_core_test.md"],
      requires: ["step003"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "axe-package-resolves",
          kind: "command",
          required: true,
          description: "Confirms that the axe-core accessibility engine resolves from the validation checkout.",
          command: "node -e \"require.resolve('axe-core')\""
        },
        {
          id: "axe-environment-report",
          kind: "artifact",
          required: true,
          description: "Records accessibility-package availability and compatibility findings.",
          path: "step_archive/step004_axe_core_test.md"
        },
        {
          id: "axe-backend-compatibility",
          kind: "check",
          required: true,
          description: "Confirms compatibility with the selected browser verification backend."
        }
      ],
      ported: true,
      next: "step005"
    },
    {
      number: 5,
      id: "step005",
      title: "c8 코드 커버리지 환경 설치",
      phase: "preflight",
      source: "assets/steps/step005.md",
      target: "codex/assets/steps/step005.md",
      source_sha256: "902d5a5ce9f8eaff9121b54ececc9206955c50326b7c86ad26965f9bd9d0339b",
      inputs: ["step_archive/step001_preflight.md"],
      outputs: ["step_archive/step005_c8_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "c8-disposition",
          kind: "check",
          required: true,
          description: "Records c8 OK with version evidence or justified SKIP with the selected runner coverage alternative."
        },
        {
          id: "c8-environment-report",
          kind: "artifact",
          required: true,
          description: "Records c8 availability and the version-command outcome.",
          path: "step_archive/step005_c8_test.md"
        }
      ],
      ported: true,
      next: "step006"
    }
  ]);
});

test("preflight outputs have required artifact evidence and safe step instructions", async () => {
  const report = await validateStepBatch(repoRoot, [1, 2, 3, 4, 5]);

  for (const step of report.steps) {
    for (const output of step.outputs) {
      assert.ok(step.acceptance.some((item) => (
        item.kind === "artifact" && item.required && item.path === output
      )), `${step.id} output lacks required artifact evidence: ${output}`);
    }

    const instructions = await readFile(join(repoRoot, step.target), "utf8");
    assert.deepEqual(scanForbiddenTokens(instructions), []);
    assert.doesNotMatch(instructions, /(?:progress|state)\.json|\.harness50-codex/i);
    assert.doesNotMatch(instructions, /\b(?:SessionStart|UserPromptSubmit|PreToolUse|Stop)\b|\bhooks?\b/i);
    assert.doesNotMatch(instructions, /(?:다음|후속)\s*(?:Step|단계)|\bnext\s+step\b/i);
  }
});

test("tooling batch declares the exact portable capability contracts", async () => {
  const report = await validateStepBatch(repoRoot, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const projected = report.steps.map((step) => ({
    number: step.number,
    id: step.id,
    title: step.title,
    phase: step.phase,
    source: step.source,
    target: step.target,
    inputs: step.inputs,
    outputs: step.outputs,
    requires: step.requires,
    optional_requires: step.optional_requires,
    network: step.network,
    visual_review: step.visual_review,
    acceptance: step.acceptance.map((item) => ({
      id: item.id,
      kind: item.kind,
      required: item.required,
      ...(item.path === undefined ? {} : { path: item.path }),
      ...(item.command === undefined ? {} : { command: item.command }),
      ...(item.command_pattern === undefined ? {} : { command_pattern: item.command_pattern })
    })),
    ported: step.ported,
    next: step.next
  }));

  assert.deepEqual(projected, [
    {
      number: 6,
      id: "step006",
      title: "Vitest/Jest 유닛 테스트 러너 환경 설치",
      phase: "tooling",
      source: "assets/steps/step006.md",
      target: "codex/assets/steps/step006.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step006_test_runner_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "test-runner-version",
          kind: "command",
          required: true,
          command_pattern: "^npx (?:vitest|jest) --version$"
        },
        {
          id: "test-runner-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step006_test_runner_test.md"
        },
        {
          id: "test-runner-selection",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step007"
    },
    {
      number: 7,
      id: "step007",
      title: "번들 분석 도구 환경 설치",
      phase: "tooling",
      source: "assets/steps/step007.md",
      target: "codex/assets/steps/step007.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step007_bundle_analyzer_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "bundle-analyzer-version",
          kind: "command",
          required: true,
          command_pattern: "^npm ls (?:rollup-plugin-visualizer|webpack-bundle-analyzer|source-map-explorer) --depth=0$"
        },
        {
          id: "bundle-analyzer-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step007_bundle_analyzer_test.md"
        },
        {
          id: "bundle-analyzer-selection",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step008"
    },
    {
      number: 8,
      id: "step008",
      title: "jscpd 코드 중복 탐지 환경 설치",
      phase: "tooling",
      source: "assets/steps/step008.md",
      target: "codex/assets/steps/step008.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step008_jscpd_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "jscpd-version",
          kind: "command",
          required: false,
          command: "npx jscpd --version"
        },
        {
          id: "jscpd-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step008_jscpd_test.md"
        },
        {
          id: "jscpd-disposition",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step009"
    },
    {
      number: 9,
      id: "step009",
      title: "Semgrep 정적 분석 환경 설치",
      phase: "tooling",
      source: "assets/steps/step009.md",
      target: "codex/assets/steps/step009.md",
      inputs: ["step_archive/step001_preflight.md"],
      outputs: ["step_archive/step009_semgrep_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "semgrep-version",
          kind: "command",
          required: false,
          command: "semgrep --version"
        },
        {
          id: "semgrep-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step009_semgrep_test.md"
        },
        {
          id: "semgrep-disposition",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step010"
    },
    {
      number: 10,
      id: "step010",
      title: "knip 미사용 코드 탐지 환경 설치",
      phase: "tooling",
      source: "assets/steps/step010.md",
      target: "codex/assets/steps/step010.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step010_knip_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "knip-version",
          kind: "command",
          required: true,
          command: "npx knip --version"
        },
        {
          id: "knip-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step010_knip_test.md"
        },
        {
          id: "knip-installation-verified",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step011"
    },
    {
      number: 11,
      id: "step011",
      title: "tokei 코드 통계 환경 설치",
      phase: "tooling",
      source: "assets/steps/step011.md",
      target: "codex/assets/steps/step011.md",
      inputs: ["step_archive/step001_preflight.md"],
      outputs: ["step_archive/step011_tokei_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "tokei-version",
          kind: "command",
          required: false,
          command: "tokei --version"
        },
        {
          id: "tokei-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step011_tokei_test.md"
        },
        {
          id: "tokei-disposition",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step012"
    },
    {
      number: 12,
      id: "step012",
      title: "Lighthouse CI 웹 성능 감사 환경 설치",
      phase: "tooling",
      source: "assets/steps/step012.md",
      target: "codex/assets/steps/step012.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step012_lhci_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "lhci-version",
          kind: "command",
          required: true,
          command: "npx lhci --version"
        },
        {
          id: "lhci-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step012_lhci_test.md"
        },
        {
          id: "lhci-installation-verified",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step013"
    },
    {
      number: 13,
      id: "step013",
      title: "stylelint CSS 린팅 환경 설치",
      phase: "tooling",
      source: "assets/steps/step013.md",
      target: "codex/assets/steps/step013.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step013_stylelint_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "stylelint-version",
          kind: "command",
          required: true,
          command: "npx stylelint --version"
        },
        {
          id: "stylelint-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step013_stylelint_test.md"
        },
        {
          id: "stylelint-installation-verified",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step014"
    },
    {
      number: 14,
      id: "step014",
      title: "Biome 포매팅/린팅 환경 설치",
      phase: "tooling",
      source: "assets/steps/step014.md",
      target: "codex/assets/steps/step014.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step014_biome_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "biome-version",
          kind: "command",
          required: true,
          command: "npx --no-install @biomejs/biome --version"
        },
        {
          id: "biome-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step014_biome_test.md"
        },
        {
          id: "biome-configuration",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step015"
    },
    {
      number: 15,
      id: "step015",
      title: "madge 순환 의존성 탐지 환경 설치",
      phase: "tooling",
      source: "assets/steps/step015.md",
      target: "codex/assets/steps/step015.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step015_madge_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "madge-version",
          kind: "command",
          required: false,
          command: "npx madge --version"
        },
        {
          id: "madge-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step015_madge_test.md"
        },
        {
          id: "madge-disposition",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step016"
    }
  ]);
});

test("tooling source hashes bind the untouched Claude steps 006 through 015", async () => {
  const index = await loadIndex(repoRoot);
  const hashes = await recordSourceHashes(repoRoot, index.steps.slice(5, 15));

  assert.deepEqual(hashes, {
    step006: "463c998455a17e60570ae84c23d8f9ab238391506f882f09e63b5d15870c19d2",
    step007: "53a97249c1e7ecb361060e4a4bc61495eca87c989015a8bee499496a76b02df6",
    step008: "8bcbbbb53562898562ecca2b3708aa4201b8195ce69517e7e88f0ea1a9d26804",
    step009: "6597da53fa43498627efdb3f6e9699fb8acb4be5624b23231ceed543adc53d26",
    step010: "e70d4ee42dd1ba93bef0c5bcc89eb5f97eb77a3a39d5f0a1a426b31a11af8a03",
    step011: "c04882c5dd36e3bdc0ea5ed8ee58e4abf5e5258e8a7633f777b0f90ac591a2e6",
    step012: "1ce157b79aff145cbb5ed9d37ee6207a676586e95ba2a6211efda14618c560a6",
    step013: "44940effc7ffbbae942950448b592f7e741c70102d19fcc7093c563809a5dd8b",
    step014: "80d122f3efc2e7a4a954e7d29b6f08106bf07624d3916b1e54a311230342c112",
    step015: "d926d99e1df12fae63baeeada6c6118b24d66c63911dba7fe8a0d40275038f09"
  });
});

test("tooling documents bind exact frontmatter titles and current-step references", async () => {
  const expected = [
    { name: "step006", number: 6, title: "Vitest/Jest 유닛 테스트 러너 환경 설치" },
    { name: "step007", number: 7, title: "번들 분석 도구 환경 설치" },
    { name: "step008", number: 8, title: "jscpd 코드 중복 탐지 환경 설치" },
    { name: "step009", number: 9, title: "Semgrep 정적 분석 환경 설치" },
    { name: "step010", number: 10, title: "knip 미사용 코드 탐지 환경 설치" },
    { name: "step011", number: 11, title: "tokei 코드 통계 환경 설치" },
    { name: "step012", number: 12, title: "Lighthouse CI 웹 성능 감사 환경 설치" },
    { name: "step013", number: 13, title: "stylelint CSS 린팅 환경 설치" },
    { name: "step014", number: 14, title: "Biome 포매팅/린팅 환경 설치" },
    { name: "step015", number: 15, title: "madge 순환 의존성 탐지 환경 설치" }
  ];

  for (const item of expected) {
    const content = await readFile(
      join(repoRoot, "codex", "assets", "steps", `${item.name}.md`),
      "utf8"
    );
    assert.deepEqual(parseStepDocument(content), {
      frontmatter: { name: item.name, phase: "tooling" },
      titles: [{ number: item.number, title: item.title }],
      referencedSteps: [item.number]
    });
  }
});

test("tooling outputs and instructions preserve safe one-step boundaries", async () => {
  const report = await validateStepBatch(repoRoot, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

  for (const step of report.steps) {
    for (const output of step.outputs) {
      assert.ok(step.acceptance.some((item) => (
        item.kind === "artifact" && item.required && item.path === output
      )), `${step.id} output lacks required artifact evidence: ${output}`);
    }

    const instructions = await readFile(join(repoRoot, step.target), "utf8");
    assert.deepEqual(scanForbiddenTokens(instructions), []);
    assert.doesNotMatch(instructions, /(?:progress|state)\.json|\.harness50-codex/i);
    assert.doesNotMatch(instructions, /\b(?:SessionStart|UserPromptSubmit|PreToolUse|Stop)\b|\bhooks?\b/i);
    assert.doesNotMatch(instructions, /(?:다음|후속)\s*(?:Step|단계)|\bnext\s+step\b/i);
    assert.match(
      instructions,
      /버전 또는 smoke 명령이 종료 코드 0으로 성공한 경우에만[^]*`설치됨`/
    );
  }
});

test("required tooling capabilities block while optional capabilities record an explicit skip", async () => {
  const required = [6, 7, 10, 12, 13, 14];
  const optional = [8, 9, 11, 15];

  for (const number of required) {
    const id = `step${String(number).padStart(3, "0")}`;
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    assert.match(content, /기능 분류:\s*필수/);
    assert.match(content, /사용할 수 없으면[^]*이 단계를 완료하지 않는다/);
    assert.doesNotMatch(content, /필수 기능[^]*`SKIP`[^]*(?:완료|수락 증거)/);
  }

  for (const number of optional) {
    const id = `step${String(number).padStart(3, "0")}`;
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    assert.match(content, /기능 분류:\s*선택/);
    assert.match(content, /사용할 수 없으면[^]*`SKIP`[^]*이유[^]*대체/);
    assert.match(content, /`SKIP`[^]*수락 증거/);
  }
});

test("tooling steps retain bounded provider-neutral worker and reviewer roles", async () => {
  const expected = [
    { name: "step006", focus: "테스트 러너 선택·설치·버전 확인" },
    { name: "step007", focus: "번들 분석 패키지 선택·설치·버전 확인" },
    { name: "step008", focus: "jscpd 설치 시도·버전 확인 또는 SKIP 근거 수집" },
    { name: "step009", focus: "Semgrep 환경 점검·설치 시도·버전 확인 또는 SKIP 근거 수집" },
    { name: "step010", focus: "knip 설치·버전 확인" },
    { name: "step011", focus: "tokei 설치 시도·버전 확인 또는 SKIP 근거 수집" },
    { name: "step012", focus: "Lighthouse CI 설치·버전 확인" },
    { name: "step013", focus: "stylelint 설치·버전 확인·기존 구성 보존" },
    { name: "step014", focus: "Biome 설치·버전 확인·구성 보존 또는 초기화" },
    { name: "step015", focus: "madge 설치 시도·버전 확인 또는 SKIP 근거 수집" }
  ];

  for (const item of expected) {
    const content = await readFile(
      join(repoRoot, "codex", "assets", "steps", `${item.name}.md`),
      "utf8"
    );
    const roleSection = /## 실행 역할\n([^]*?)(?=\n## )/.exec(content)?.[1];

    assert.ok(roleSection, `${item.name} is missing its provider-neutral role contract`);
    assert.match(roleSection, new RegExp(item.focus));
    assert.match(roleSection, /현재 단계 범위[^]*도구 준비 작업자 역할[^]*위임/);
    assert.match(roleSection, /검증자 역할[^]*작업자 결과를 그대로 수락하지 않고/);
    assert.match(roleSection, /위임 기능을 사용할 수 없으면 현재 실행자가[^]*순서대로 수행/);
    assert.match(roleSection, /별도 작업자를 사용했다고 기록하지 않는다/);
    assert.match(roleSection, /정상 권한 확인/);
    assert.doesNotMatch(content, /\b(?:Claude|Haiku|Sonnet)\b/i);
  }
});

test("step015 preserves the recommended MX note severity without making it acceptance", async () => {
  const content = await readFile(
    join(repoRoot, "codex", "assets", "steps", "step015.md"),
    "utf8"
  );
  const annotationSection = /## 이후 소스 주석 계약\n([^]*?)(?=\n## )/.exec(content)?.[1];

  assert.ok(annotationSection, "step015 is missing its source-annotation contract");
  assert.match(annotationSection, /태그를 사용할 때[^]*정식 형식/);
  assert.match(annotationSection, /@MX:ANCHOR:[^\n]*fan_in\s*>=\s*3/);
  assert.match(annotationSection, /`@MX:NOTE`[^]*(?:권장|권고)/);
  assert.doesNotMatch(
    annotationSection,
    /`@MX:NOTE`[^]{0,100}(?:반드시|필수|의무|최소 하나 둔다)/
  );

  const index = await loadIndex(repoRoot);
  assert.ok(index.steps[14].acceptance.every((item) => !/mx|note/i.test(item.id)));
});

test("research batch declares the exact Codex-native evidence contracts", async () => {
  const report = await validateStepBatch(repoRoot, [16, 17, 18, 19, 20, 21, 22, 23, 24]);
  const projected = report.steps.map((step) => ({
    number: step.number,
    id: step.id,
    title: step.title,
    phase: step.phase,
    source: step.source,
    target: step.target,
    source_sha256: step.source_sha256,
    inputs: step.inputs,
    outputs: step.outputs,
    requires: step.requires,
    optional_requires: step.optional_requires,
    network: step.network,
    visual_review: step.visual_review,
    acceptance: step.acceptance.map((item) => ({
      id: item.id,
      kind: item.kind,
      required: item.required,
      ...(item.path === undefined ? {} : { path: item.path })
    })),
    ported: step.ported,
    next: step.next
  }));

  assert.deepEqual(projected, [
    {
      number: 16,
      id: "step016",
      title: "전체 조사",
      phase: "research",
      source: "assets/steps/step016.md",
      target: "codex/assets/steps/step016.md",
      source_sha256: "2ee59157b76cba85b004c49c76daff3b7812b86308d8023c8ff9ba6e6b49e176",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step001_preflight.md",
        "step_archive/step002_context전략_chunk1.md"
      ],
      outputs: [
        "step_archive/step016_조사결과_chunk1.md",
        "step_archive/research-raw-step016-primary.txt",
        "step_archive/screenshots/research/step016-primary.png"
      ],
      requires: ["step001", "step002"],
      optional_requires: ["step011"],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "research-chunk-1", kind: "artifact", required: true, path: "step_archive/step016_조사결과_chunk1.md" },
        { id: "research-raw-primary", kind: "artifact", required: true, path: "step_archive/research-raw-step016-primary.txt" },
        { id: "research-screenshot-primary", kind: "artifact", required: true, path: "step_archive/screenshots/research/step016-primary.png" },
        { id: "research-attribution", kind: "check", required: true },
        { id: "research-chunks-bounded", kind: "check", required: true },
        { id: "code-baseline-disposition", kind: "check", required: true },
        { id: "tokei-baseline", kind: "artifact", required: false, path: "step_archive/tokei-baseline.json" }
      ],
      ported: true,
      next: "step017"
    },
    {
      number: 17,
      id: "step017",
      title: "GitHub 조사",
      phase: "research",
      source: "assets/steps/step017.md",
      target: "codex/assets/steps/step017.md",
      source_sha256: "941288a9368915036af4f69ddac2ef1a605b8dd6181c277314f38c1b489f3fe9",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step016_조사결과_chunk1.md"
      ],
      outputs: [
        "step_archive/step017_조사결과_chunk1.md",
        "step_archive/research-raw-step017-github-api.json"
      ],
      requires: ["step016"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "github-research-chunk-1", kind: "artifact", required: true, path: "step_archive/step017_조사결과_chunk1.md" },
        { id: "github-api-raw", kind: "artifact", required: true, path: "step_archive/research-raw-step017-github-api.json" },
        { id: "github-api-response", kind: "check", required: true },
        { id: "github-attribution", kind: "check", required: true },
        { id: "github-chunks-bounded", kind: "check", required: true }
      ],
      ported: true,
      next: "step018"
    },
    {
      number: 18,
      id: "step018",
      title: "API 계약 문서 조사",
      phase: "research",
      source: "assets/steps/step018.md",
      target: "codex/assets/steps/step018.md",
      source_sha256: "7205da602ce035fc4f372798523f028fa21e1002da7425948d3731b90e290263",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step016_조사결과_chunk1.md"
      ],
      outputs: [
        "step_archive/step018_조사결과_chunk1.md",
        "step_archive/research-raw-step018-api-contract.txt"
      ],
      requires: ["step016"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "api-contract-chunk-1", kind: "artifact", required: true, path: "step_archive/step018_조사결과_chunk1.md" },
        { id: "api-contract-raw", kind: "artifact", required: true, path: "step_archive/research-raw-step018-api-contract.txt" },
        { id: "concrete-contract-subject", kind: "check", required: true },
        { id: "api-contract-attribution", kind: "check", required: true },
        { id: "api-contract-chunks-bounded", kind: "check", required: true }
      ],
      ported: true,
      next: "step019"
    },
    {
      number: 19,
      id: "step019",
      title: "참고 레포지토리 클론 및 코드 분석",
      phase: "research",
      source: "assets/steps/step019.md",
      target: "codex/assets/steps/step019.md",
      source_sha256: "d34370dc09411a8724906cc17965188f6d9f179a69b0997b0b036ccbfe9225c0",
      inputs: [
        "step_archive/step017_조사결과_chunk1.md",
        "step_archive/research-raw-step017-github-api.json"
      ],
      outputs: [
        "step_archive/step019_조사결과_chunk1.md",
        "step_archive/references/clone-manifest.md"
      ],
      requires: ["step017"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "repository-analysis-chunk-1", kind: "artifact", required: true, path: "step_archive/step019_조사결과_chunk1.md" },
        { id: "clone-manifest", kind: "artifact", required: true, path: "step_archive/references/clone-manifest.md" },
        { id: "bounded-shallow-clones", kind: "check", required: true },
        { id: "cloned-code-quarantine", kind: "check", required: true },
        { id: "repository-analysis-chunks-bounded", kind: "check", required: true }
      ],
      ported: true,
      next: "step020"
    },
    {
      number: 20,
      id: "step020",
      title: "Awwwards 사이트 선정",
      phase: "research",
      source: "assets/steps/step020.md",
      target: "codex/assets/steps/step020.md",
      source_sha256: "90773dc6f6b658373eb3fe6a1bca1dc6d0a63a1c3fcff8d4238b28f9e2cf9b87",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step016_조사결과_chunk1.md"
      ],
      outputs: [
        "step_archive/step020_선정URL.md",
        "step_archive/research-raw-step020-awwwards.txt"
      ],
      requires: ["step016"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "selected-awwwards-urls", kind: "artifact", required: true, path: "step_archive/step020_선정URL.md" },
        { id: "awwwards-listing-raw", kind: "artifact", required: true, path: "step_archive/research-raw-step020-awwwards.txt" },
        { id: "evidence-derived-selection", kind: "check", required: true },
        { id: "selected-url-attribution", kind: "check", required: true },
        { id: "bounded-site-set", kind: "check", required: true }
      ],
      ported: true,
      next: "step021"
    },
    {
      number: 21,
      id: "step021",
      title: "의존성 게이트 검증",
      phase: "research",
      source: "assets/steps/step021.md",
      target: "codex/assets/steps/step021.md",
      source_sha256: "849e25eae349bd231fac96c0adc5bd5fc7fe4d6c32b0c6230803b65af66b52a9",
      inputs: ["step_archive/step001_preflight.md"],
      outputs: ["step_archive/step021_gate_status.md"],
      requires: ["step001"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "step001-preflight-artifact", kind: "artifact", required: true, path: "step_archive/step001_preflight.md" },
        { id: "dependency-gate-status", kind: "artifact", required: true, path: "step_archive/step021_gate_status.md" },
        { id: "step001-receipt-and-artifact", kind: "check", required: true },
        { id: "project-conditional-prerequisites", kind: "check", required: true },
        { id: "optional-step-deps", kind: "check", required: true }
      ],
      ported: true,
      next: "step022"
    },
    {
      number: 22,
      id: "step022",
      title: "Awwwards 데이터 수집",
      phase: "research",
      source: "assets/steps/step022.md",
      target: "codex/assets/steps/step022.md",
      source_sha256: "3d311d4bf02f8476d01be2d13220590e60b9ca412d38f29e476dbf3859fce88d",
      inputs: [
        "step_archive/step020_선정URL.md",
        "step_archive/research-raw-step020-awwwards.txt"
      ],
      outputs: [
        "step_archive/step022_수집결과_chunk1.md",
        "step_archive/awwwards-step022-primary.txt",
        "step_archive/screenshots/research/step022-primary-desktop.png"
      ],
      requires: ["step020"],
      optional_requires: [],
      network: true,
      visual_review: true,
      acceptance: [
        { id: "awwwards-collection-chunk-1", kind: "artifact", required: true, path: "step_archive/step022_수집결과_chunk1.md" },
        { id: "awwwards-raw-primary", kind: "artifact", required: true, path: "step_archive/awwwards-step022-primary.txt" },
        { id: "awwwards-screenshot-primary", kind: "artifact", required: true, path: "step_archive/screenshots/research/step022-primary-desktop.png" },
        { id: "selected-url-input", kind: "check", required: true },
        { id: "capture-attribution", kind: "check", required: true },
        { id: "visual-capture-inspection", kind: "check", required: true },
        { id: "bounded-capture-scope", kind: "check", required: true }
      ],
      ported: true,
      next: "step023"
    },
    {
      number: 23,
      id: "step023",
      title: "Awwwards 디자인 패턴 분석",
      phase: "research",
      source: "assets/steps/step023.md",
      target: "codex/assets/steps/step023.md",
      source_sha256: "d9e8d4343416266b2757d21aeaf130bd945225ef74b9e04817873741fc9f9d0b",
      inputs: [
        "step_archive/step016_조사결과_chunk1.md",
        "step_archive/step022_수집결과_chunk1.md",
        "step_archive/awwwards-step022-primary.txt",
        "step_archive/screenshots/research/step022-primary-desktop.png"
      ],
      outputs: ["step_archive/step023_조사결과_chunk1.md"],
      requires: ["step016", "step022"],
      optional_requires: [],
      network: false,
      visual_review: true,
      acceptance: [
        { id: "design-pattern-chunk-1", kind: "artifact", required: true, path: "step_archive/step023_조사결과_chunk1.md" },
        { id: "research-screenshot-input", kind: "artifact", required: true, path: "step_archive/screenshots/research/step022-primary-desktop.png" },
        { id: "all-captures-traced", kind: "check", required: true },
        { id: "named-aesthetic-axes", kind: "check", required: true },
        { id: "visual-pattern-inspection", kind: "check", required: true },
        { id: "design-analysis-chunks-bounded", kind: "check", required: true }
      ],
      ported: true,
      next: "step024"
    },
    {
      number: 24,
      id: "step024",
      title: "Awwwards 조사 충분성 검증",
      phase: "research",
      source: "assets/steps/step024.md",
      target: "codex/assets/steps/step024.md",
      source_sha256: "feef8544a175f0acf352c4c776d62046b315b867aabfae43d7795bb213413ea8",
      inputs: [
        "step_archive/step016_조사결과_chunk1.md",
        "step_archive/step020_선정URL.md",
        "step_archive/research-raw-step020-awwwards.txt",
        "step_archive/step022_수집결과_chunk1.md",
        "step_archive/awwwards-step022-primary.txt",
        "step_archive/screenshots/research/step022-primary-desktop.png",
        "step_archive/step023_조사결과_chunk1.md"
      ],
      outputs: ["step_archive/outputs/step024_검증_r1.md"],
      requires: ["step016", "step020", "step022", "step023"],
      optional_requires: [],
      network: true,
      visual_review: true,
      acceptance: [
        { id: "sufficiency-verification-round-1", kind: "artifact", required: true, path: "step_archive/outputs/step024_검증_r1.md" },
        { id: "verification-screenshot-input", kind: "artifact", required: true, path: "step_archive/screenshots/research/step022-primary-desktop.png" },
        { id: "independent-verifier", kind: "check", required: true },
        { id: "bounded-verification-rounds", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true },
        { id: "visual-sufficiency-inspection", kind: "check", required: true }
      ],
      ported: true,
      next: "step025"
    }
  ]);
});

test("research source hashes bind the untouched Claude steps 016 through 024", async () => {
  const index = await loadIndex(repoRoot);
  const hashes = await recordSourceHashes(repoRoot, index.steps.slice(15, 24));

  assert.deepEqual(hashes, {
    step016: "2ee59157b76cba85b004c49c76daff3b7812b86308d8023c8ff9ba6e6b49e176",
    step017: "941288a9368915036af4f69ddac2ef1a605b8dd6181c277314f38c1b489f3fe9",
    step018: "7205da602ce035fc4f372798523f028fa21e1002da7425948d3731b90e290263",
    step019: "d34370dc09411a8724906cc17965188f6d9f179a69b0997b0b036ccbfe9225c0",
    step020: "90773dc6f6b658373eb3fe6a1bca1dc6d0a63a1c3fcff8d4238b28f9e2cf9b87",
    step021: "849e25eae349bd231fac96c0adc5bd5fc7fe4d6c32b0c6230803b65af66b52a9",
    step022: "3d311d4bf02f8476d01be2d13220590e60b9ca412d38f29e476dbf3859fce88d",
    step023: "d9e8d4343416266b2757d21aeaf130bd945225ef74b9e04817873741fc9f9d0b",
    step024: "feef8544a175f0acf352c4c776d62046b315b867aabfae43d7795bb213413ea8"
  });
});

test("research documents bind exact frontmatter titles and current-step references", async () => {
  const expected = [
    { name: "step016", number: 16, title: "전체 조사" },
    { name: "step017", number: 17, title: "GitHub 조사" },
    { name: "step018", number: 18, title: "API 계약 문서 조사" },
    { name: "step019", number: 19, title: "참고 레포지토리 클론 및 코드 분석" },
    { name: "step020", number: 20, title: "Awwwards 사이트 선정" },
    { name: "step021", number: 21, title: "의존성 게이트 검증" },
    { name: "step022", number: 22, title: "Awwwards 데이터 수집" },
    { name: "step023", number: 23, title: "Awwwards 디자인 패턴 분석" },
    { name: "step024", number: 24, title: "Awwwards 조사 충분성 검증" }
  ];

  for (const item of expected) {
    const content = await readFile(
      join(repoRoot, "codex", "assets", "steps", `${item.name}.md`),
      "utf8"
    );
    assert.deepEqual(parseStepDocument(content), {
      frontmatter: { name: item.name, phase: "research" },
      titles: [{ number: item.number, title: item.title }],
      referencedSteps: [item.number]
    });
  }
});

test("research outputs have required artifacts and an upstream dependency graph", async () => {
  const report = await validateStepBatch(repoRoot, [16, 17, 18, 19, 20, 21, 22, 23, 24]);
  const byId = new Map((await loadIndex(repoRoot)).steps.map((step) => [step.id, step]));

  for (const step of report.steps) {
    for (const output of step.outputs) {
      assert.ok(step.acceptance.some((item) => (
        item.kind === "artifact" && item.required && item.path === output
      )), `${step.id} output lacks required artifact evidence: ${output}`);
    }
    for (const dependency of step.requires) {
      assert.ok(byId.get(dependency).number < step.number, `${step.id} has a non-upstream dependency`);
    }
  }

  assert.deepEqual(report.steps.map((step) => ({
    id: step.id,
    requires: step.requires,
    optional_requires: step.optional_requires
  })), [
    { id: "step016", requires: ["step001", "step002"], optional_requires: ["step011"] },
    { id: "step017", requires: ["step016"], optional_requires: [] },
    { id: "step018", requires: ["step016"], optional_requires: [] },
    { id: "step019", requires: ["step017"], optional_requires: [] },
    { id: "step020", requires: ["step016"], optional_requires: [] },
    { id: "step021", requires: ["step001"], optional_requires: [] },
    { id: "step022", requires: ["step020"], optional_requires: [] },
    { id: "step023", requires: ["step016", "step022"], optional_requires: [] },
    { id: "step024", requires: ["step016", "step020", "step022", "step023"], optional_requires: [] }
  ]);
});

test("research instructions block missing mandatory evidence and trace every factual claim", async () => {
  const networkSteps = [16, 17, 18, 19, 20, 22];

  for (const number of networkSteps) {
    const id = `step${String(number).padStart(3, "0")}`;
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    assert.match(content, /네트워크 기능[^]*사용할 수 없으면[^]*완료하지 않는다/);
    assert.match(content, /최대 세 번/);
    assert.match(content, /(?:URL|요청 URL)[^]*(?:출처|원본)[^]*(?:수집 시각|응답 시각)/);
    assert.match(content, /사실 주장[^]*(?:URL|출처)[^]*(?:원본|캡처)/);
    assert.match(content, /증거를 (?:발명|꾸며)/);
  }

  const step18 = await readFile(join(repoRoot, "codex", "assets", "steps", "step018.md"), "utf8");
  assert.match(step18, /주제 입력과 프로젝트 증거[^]*계약 대상을 도출/);
  assert.match(step18, /구체적인 계약 출처[^]*식별할 수 없으면[^]*완료하지 않는다/);
  assert.doesNotMatch(step18, /임의(?:의|로)[^]*(?:API|계약)/);
});

test("research instructions use safe one-step provider-neutral contracts", async () => {
  const report = await validateStepBatch(repoRoot, [16, 17, 18, 19, 20, 21, 22, 23, 24]);

  for (const step of report.steps) {
    const content = await readFile(join(repoRoot, step.target), "utf8");
    assert.deepEqual(scanForbiddenTokens(content), []);
    assert.doesNotMatch(content, /(?:progress|state)\.json|\.harness50-codex/i);
    assert.doesNotMatch(content, /\b(?:SessionStart|UserPromptSubmit|PreToolUse|Stop)\b|\bhooks?\b/i);
    assert.doesNotMatch(content, /(?:다음|후속)\s*(?:Step|단계)|\bnext\s+step\b/i);
    assert.doesNotMatch(content, /별도 (?:작업자|검증자)를 사용했다고 (?:기록|주장)/);
  }
});

test("every research step defines concrete independent roles and an honest sequential fallback", async () => {
  const roleContracts = [
    {
      number: 16,
      worker: /조사 질문별 수집 역할/,
      reviewer: /수집 결과를 원본과 대조하는 독립 검토\s*역할/
    },
    {
      number: 17,
      worker: /API 수집 역할/,
      reviewer: /응답 원본으로 확인하는 독립 검토\s*역할/
    },
    {
      number: 18,
      worker: /계약 문서별 수집 역할/,
      reviewer: /계약 항목을 원본에 대조하는 독립 검토\s*역할/
    },
    {
      number: 19,
      worker: /저장소별 수집 역할/,
      reviewer: /정적 분석을 원본 파일에 대조하는 독립 검토\s*역할/
    },
    {
      number: 20,
      worker: /특성별 후보 수집 역할/,
      reviewer: /등재·관련성을 원본에 대조하는 독립 검토\s*역할/
    },
    {
      number: 21,
      worker: /결정적 의존성 검사 작업자/,
      reviewer: /보고서를\s*수정하지 않는 독립 검증자/
    },
    {
      number: 22,
      worker: /선정 사이트별 수집 역할/,
      reviewer: /원본·스크린샷을 실제로 확인하는 독립 검토\s*역할/
    },
    {
      number: 23,
      worker: /수집 증거를 축별로 분석하는 역할/,
      reviewer: /결론을 원본에 대조하는 독립 검토\s*역할/
    },
    {
      number: 24,
      worker: /23단계 분석을 만든 역할/,
      reviewer: /구분된 독립 검증자 역할/
    }
  ];

  for (const { number, worker, reviewer } of roleContracts) {
    const id = `step${String(number).padStart(3, "0")}`;
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    const roleSection = /## 실행 역할\n([^]*?)(?=\n## )/.exec(content)?.[1];
    assert.ok(roleSection, `${id} is missing its provider-neutral role contract`);
    const normalizedRole = roleSection.replace(/\s+/g, " ").trim();
    assert.match(normalizedRole, worker, `${id} is missing its concrete worker role`);
    assert.match(normalizedRole, reviewer, `${id} is missing its independent reviewer role`);
    assert.match(normalizedRole, /위임 기능을 사용할 수 없으면[^]*현재 실행자가[^]*순서대로 수행/);
    assert.match(normalizedRole, /별도 역할을 위임했다고 기록하지 않는다/);
    assert.match(normalizedRole, /정상 권한 확인/);
  }

  const step21 = await readFile(join(repoRoot, "codex", "assets", "steps", "step021.md"), "utf8");
  const step21RoleSection = /## 실행 역할\n([^]*?)(?=\n## )/.exec(step21)?.[1];
  assert.ok(step21RoleSection, "step021 role checks must stay inside its role section");
  const step21Roles = step21RoleSection.replace(/\s+/g, " ").trim();
  assert.match(step21Roles, /동일한 입력[^]*1단계 완료 영수증[^]*프로젝트 manifest[^]*독립적으로 재확인/);
  assert.match(step21Roles, /결정적 명령[^]*독립적으로 재실행/);
  assert.match(step21Roles, /독립 검증자[^]*(?:상태 )?보고서[^]*수정하지 않/);
  assert.match(step21Roles, /병렬 실행[^]*위임 기능을 사용할 수 없으면[^]*역할을 명확히 분리[^]*순서대로 수행/);
  assert.match(step21Roles, /자동 승인[^]*권한 우회[^]*금지/);
});

test("step017 exhausts bounded searches before no-reference and step019 permits exactly zero clones only for that disposition", async () => {
  const { steps: [research, clones] } = await validateStepBatch(repoRoot, [17, 19]);
  const step17 = await readFile(join(repoRoot, research.target), "utf8");
  const step19 = await readFile(join(repoRoot, clones.target), "utf8");
  const raw = "step_archive/research-raw-step017-github-api.json";

  assert.ok(research.outputs.includes(raw));
  assert.ok(clones.inputs.includes(raw));
  assert.ok(research.acceptance.some(item => item.kind === "artifact" && item.required && item.path === raw));
  assert.ok(clones.outputs.includes("step_archive/references/clone-manifest.md"));

  assert.match(step17, /각 후보당 최대 한 번[^]*총 최대 세 번/);
  assert.match(step17, /HTTP 성공만으로 중단하지 않는다/);
  assert.match(step17, /`items=\[\]` 또는 모두 무관하면[^]*남은 우선순위 검색어로 계속/);
  assert.match(step17, /사용 가능한 후보가 하나 이상이면[^]*추가 API 요청을 중단/);
  assert.match(step17, /세 개의 서로 다른 우선순위 검색어 모두 실제 성공 응답을 보존했지만[^]*사용 가능한 후보가 없을 때만[^]*`disposition: exhausted-no-reference`/);
  assert.match(step17, /요청 실패·권한 차단·rate limit[^]*이 대안을 사용할 수 없고 INCOMPLETE/);
  assert.match(step17, /기존 원본을 덮어쓰거나 응답을 합치지 않는다/);

  assert.match(step19, /`exhausted-no-reference`[^]*검증되면 복제하지 않는다/);
  assert.match(step19, /복제 수 0[^]*정적 코드 분석 없음의 한계/);
  assert.match(step19, /완료 가능한 대안[^]*최소 1개 복제 요건을 적용하지 않는다/);
  assert.match(step19, /후보가 있는 분기의 복제 실패나 권한 차단[^]*이 대안으로 바꾸지 않는다/);
  assert.match(step19, /`candidates` 분기에서는 최소 한 개의 관련 저장소를 실제 복제하지 못하면 완료하지\s*않는다/);
});

test("visual research requires screenshots and actual inspection for steps 022 through 024", async () => {
  const report = await validateStepBatch(repoRoot, [22, 23, 24]);

  for (const step of report.steps) {
    assert.equal(step.visual_review, true);
    assert.ok(step.acceptance.some((item) => (
      item.kind === "artifact" && item.required && /screenshot/i.test(`${item.id} ${item.path}`)
    )));
    assert.ok(step.acceptance.some((item) => item.kind === "check" && item.required));

    const content = await readFile(join(repoRoot, step.target), "utf8");
    assert.match(content, /시각 검사 기능[^]*사용할 수 없으면[^]*완료하지 않는다/);
    assert.match(content, /실제로[^]*(?:열어|검사)/);
  }
});

test("step019 confines untrusted clones and never executes their code", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step019.md"), "utf8");

  assert.match(content, /최대 5개/);
  assert.match(content, /`git clone --depth 1`/);
  assert.match(content, /검증된 `step_archive\/references\/[a-z0-9][a-z0-9._-]*`/);
  assert.match(content, /실패[^]*manifest[^]*기록/);
  assert.match(content, /클론한 코드[^]*(?:실행|설치|빌드|스크립트)[^]*금지/);
  assert.match(content, /심볼릭 링크[^]*경계 밖[^]*완료하지 않는다/);
});

test("step021 is a local deterministic gate over the step001 receipt and artifact", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step021.md"), "utf8");

  assert.match(content, /1단계 완료 영수증[^]*`step_archive\/step001_preflight\.md`/);
  assert.match(content, /로컬[^]*결정적/);
  assert.match(content, /네트워크[^]*사용하지 않는다/);
  assert.match(content, /설치[^]*수행하지 않는다/);
  assert.match(content, /`step_archive\/step-deps\.json`[^]*선택 입력/);
  assert.match(content, /`package\.json`[^]*`node_modules`[^]*프로젝트 조건부/);
  assert.match(content, /선언된[^]*선행 파일[^]*누락[^]*완료하지 않는다/);
  assert.match(content, /`step_archive\/step021_gate_status\.md`[^]*기록/);
});

test("step022 consumes the selected URLs and blocks incomplete visual collection", async () => {
  const report = await validateStepBatch(repoRoot, [20, 22]);
  const [selection, collection] = report.steps;
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step022.md"), "utf8");

  assert.ok(selection.outputs.includes("step_archive/research-raw-step020-awwwards.txt"));
  assert.ok(collection.inputs.includes("step_archive/research-raw-step020-awwwards.txt"));
  assert.match(content, /`step_archive\/step020_선정URL\.md`[^]*URL만/);
  assert.match(content, /선정 목록 밖의 URL[^]*수집하지 않는다/);
  assert.match(content, /원본 텍스트[^]*스크린샷[^]*둘 다/);
  assert.match(content, /URL별 최대 10개 페이지/);
  assert.match(content, /반응형[^]*1920×1080[^]*768×1024[^]*390×844/);
  assert.match(content, /시각 검사 기능[^]*사용할 수 없으면[^]*완료하지 않는다/);
});

test("step023 preserves every named source axis without inventing the numeric mismatch", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step023.md"), "utf8");

  for (const axis of [
    "Brutalism", "Glassmorphism", "Minimalism", "Dark OLED Luxury", "Neumorphism", "Cyberpunk"
  ]) {
    assert.match(content, new RegExp(axis));
  }
  assert.match(content, /원본에 이름이 명시된 여섯 미학 축/);
  assert.doesNotMatch(content, /11가지 미학 축/);
  assert.match(content, /레이아웃[^]*색상[^]*간격[^]*타이포그래피[^]*인터랙션/);
  assert.match(content, /각 대안[^]*최소 2개[^]*장단점/);
});

test("step024 keeps every bounded verification round inside its declared artifact", async () => {
  const report = await validateStepBatch(repoRoot, [24]);
  const step = report.steps[0];
  const content = await readFile(join(repoRoot, step.target), "utf8");
  const mentionedRoundArtifacts = [...new Set(
    [...content.matchAll(/`(step_archive\/outputs\/step024_검증_r\d+\.md)`/g)]
      .map((match) => match[1])
  )];

  assert.deepEqual(step.outputs, ["step_archive/outputs/step024_검증_r1.md"]);
  assert.ok(step.inputs.includes("step_archive/awwwards-step022-primary.txt"));
  assert.deepEqual(mentionedRoundArtifacts, step.outputs);
  assert.doesNotMatch(content, /step024_검증_r[2-5]\.md/);
  assert.match(content, /모든 라운드[^]*동일한 선언 산출물[^]*라운드별 섹션/);
  assert.match(content, /라운드 1[^]*라운드 5/);
});

test("step024 requires a bounded independent PASS and never auto-routes a FAIL", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step024.md"), "utf8");

  assert.match(content, /독립 검증자 역할/);
  assert.match(content, /최대 5라운드/);
  assert.match(content, /`PASS`[^]*경우에만[^]*완료/);
  assert.match(content, /`FAIL`[^]*완료 증거[^]*될 수 없다/);
  assert.match(content, /`FAIL`[^]*자동으로[^]*(?:이동|실행|전환)[^]*않는다/);
  assert.match(content, /5라운드[^]*`PASS`[^]*없으면[^]*차단/);
  assert.doesNotMatch(content, /스킵 처리[^]*(?:완료|종료)/);
});

test("planning batch declares the exact Codex-native artifact contracts", async () => {
  const report = await validateStepBatch(repoRoot, [25, 26, 27, 28, 29, 30]);
  assertPlanningAcceptanceDescriptions(report.steps);
  const projected = report.steps.map((step) => ({
    number: step.number,
    id: step.id,
    title: step.title,
    phase: step.phase,
    source: step.source,
    target: step.target,
    source_sha256: step.source_sha256,
    inputs: step.inputs,
    outputs: step.outputs,
    requires: step.requires,
    optional_requires: step.optional_requires,
    network: step.network,
    visual_review: step.visual_review,
    acceptance: step.acceptance.map((item) => ({
      id: item.id,
      kind: item.kind,
      required: item.required,
      ...(item.path === undefined ? {} : { path: item.path })
    })),
    ported: step.ported,
    next: step.next
  }));

  assert.deepEqual(projected, [
    {
      number: 25,
      id: "step025",
      title: "기획: 전체 조사결과 기반 (독립 검증 루프)",
      phase: "planning",
      source: "assets/steps/step025.md",
      target: "codex/assets/steps/step025.md",
      source_sha256: "0cc2be6f4cc2785c73bc836236a868915bb058c61532eac9abe235e48e438c0c",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step016_조사결과_chunk1.md",
        "step_archive/research-raw-step016-primary.txt",
        "step_archive/screenshots/research/step016-primary.png",
        "step_archive/outputs/step024_검증_r1.md"
      ],
      outputs: [
        "step_archive/step025_planning_chunk1.md",
        "step_archive/outputs/step025_검증.md"
      ],
      requires: ["step016", "step024"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "base-planning-snapshot", kind: "artifact", required: true, path: "step_archive/step025_planning_chunk1.md" },
        { id: "planning-verification-report", kind: "artifact", required: true, path: "step_archive/outputs/step025_검증.md" },
        { id: "topic-fidelity", kind: "check", required: true },
        { id: "general-research-provenance", kind: "check", required: true },
        { id: "planning-chunks-bounded", kind: "check", required: true },
        { id: "bounded-independent-review", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true }
      ],
      ported: true,
      next: "step026"
    },
    {
      number: 26,
      id: "step026",
      title: "기획 보강: GitHub 조사결과",
      phase: "planning",
      source: "assets/steps/step026.md",
      target: "codex/assets/steps/step026.md",
      source_sha256: "0bb2cb849d90f624ca2a5e28fe7e30f3cd41e342f3dbfb1b3b900cc869f5b288",
      inputs: [
        "step_archive/step025_planning_chunk1.md",
        "step_archive/outputs/step025_검증.md",
        "step_archive/step017_조사결과_chunk1.md",
        "step_archive/research-raw-step017-github-api.json"
      ],
      outputs: [
        "step_archive/step026_planning_chunk1.md",
        "step_archive/outputs/step026_검증.md"
      ],
      requires: ["step017", "step025"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "github-planning-snapshot", kind: "artifact", required: true, path: "step_archive/step026_planning_chunk1.md" },
        { id: "github-planning-verification", kind: "artifact", required: true, path: "step_archive/outputs/step026_검증.md" },
        { id: "persisted-github-response-only", kind: "check", required: true },
        { id: "decision-provenance", kind: "check", required: true },
        { id: "planning-chunks-bounded", kind: "check", required: true },
        { id: "bounded-independent-review", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true }
      ],
      ported: true,
      next: "step027"
    },
    {
      number: 27,
      id: "step027",
      title: "기획 보강: API 계약 문서 조사결과",
      phase: "planning",
      source: "assets/steps/step027.md",
      target: "codex/assets/steps/step027.md",
      source_sha256: "fe4d854999ffb844df3ed0b08d9a19ae6f69b48dbcb9cab5568af87725661154",
      inputs: [
        "step_archive/step026_planning_chunk1.md",
        "step_archive/outputs/step026_검증.md",
        "step_archive/step018_조사결과_chunk1.md",
        "step_archive/research-raw-step018-api-contract.txt"
      ],
      outputs: [
        "step_archive/step027_planning_chunk1.md",
        "step_archive/outputs/step027_검증.md"
      ],
      requires: ["step018", "step026"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "api-contract-planning-snapshot", kind: "artifact", required: true, path: "step_archive/step027_planning_chunk1.md" },
        { id: "api-contract-planning-verification", kind: "artifact", required: true, path: "step_archive/outputs/step027_검증.md" },
        { id: "concrete-contract-provenance", kind: "check", required: true },
        { id: "schema-contract-completeness", kind: "check", required: true },
        { id: "planning-chunks-bounded", kind: "check", required: true },
        { id: "bounded-independent-review", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true }
      ],
      ported: true,
      next: "step028"
    },
    {
      number: 28,
      id: "step028",
      title: "기획 보강: 참고 레포 코드 분석",
      phase: "planning",
      source: "assets/steps/step028.md",
      target: "codex/assets/steps/step028.md",
      source_sha256: "668fccf59d666c9f910db6db5f65f728296075c9b3b57a3d1c502b837173b0f0",
      inputs: [
        "step_archive/step027_planning_chunk1.md",
        "step_archive/outputs/step027_검증.md",
        "step_archive/step019_조사결과_chunk1.md",
        "step_archive/references/clone-manifest.md"
      ],
      outputs: [
        "step_archive/step028_planning_chunk1.md",
        "step_archive/outputs/step028_검증.md"
      ],
      requires: ["step019", "step027"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "repository-planning-snapshot", kind: "artifact", required: true, path: "step_archive/step028_planning_chunk1.md" },
        { id: "repository-planning-verification", kind: "artifact", required: true, path: "step_archive/outputs/step028_검증.md" },
        { id: "static-analysis-only", kind: "check", required: true },
        { id: "decision-provenance", kind: "check", required: true },
        { id: "planning-chunks-bounded", kind: "check", required: true },
        { id: "bounded-independent-review", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true }
      ],
      ported: true,
      next: "step029"
    },
    {
      number: 29,
      id: "step029",
      title: "기획 보강: Awwwards UX/UI·레이아웃 조사결과",
      phase: "planning",
      source: "assets/steps/step029.md",
      target: "codex/assets/steps/step029.md",
      source_sha256: "1fd555a48ff56181aa51ec4b6c4ee35c6396fd78cfaa8d2e1ca6b2318782b5db",
      inputs: [
        "step_archive/step028_planning_chunk1.md",
        "step_archive/outputs/step028_검증.md",
        "step_archive/step022_수집결과_chunk1.md",
        "step_archive/awwwards-step022-primary.txt",
        "step_archive/screenshots/research/step022-primary-desktop.png",
        "step_archive/step023_조사결과_chunk1.md",
        "step_archive/outputs/step024_검증_r1.md"
      ],
      outputs: [
        "step_archive/step029_planning_chunk1.md",
        "step_archive/outputs/step029_검증.md"
      ],
      requires: ["step022", "step023", "step024", "step028"],
      optional_requires: [],
      network: false,
      visual_review: true,
      acceptance: [
        { id: "visual-planning-snapshot", kind: "artifact", required: true, path: "step_archive/step029_planning_chunk1.md" },
        { id: "visual-planning-verification", kind: "artifact", required: true, path: "step_archive/outputs/step029_검증.md" },
        { id: "planning-screenshot-input", kind: "artifact", required: true, path: "step_archive/screenshots/research/step022-primary-desktop.png" },
        { id: "evidence-axis-fidelity", kind: "check", required: true },
        { id: "interaction-accessibility-contracts", kind: "check", required: true },
        { id: "visual-evidence-inspection", kind: "check", required: true },
        { id: "planning-chunks-bounded", kind: "check", required: true },
        { id: "bounded-independent-review", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true }
      ],
      ported: true,
      next: "step030"
    },
    {
      number: 30,
      id: "step030",
      title: "통합 설계 (레이아웃 + 전체)",
      phase: "planning",
      source: "assets/steps/step030.md",
      target: "codex/assets/steps/step030.md",
      source_sha256: "362a1eefab0c424fd66b3e18f1a7bb04285f64b55a281e8ab7ec93e3aa308076",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step029_planning_chunk1.md",
        "step_archive/outputs/step029_검증.md"
      ],
      outputs: [
        "step_archive/outputs/step030_설계대안.md",
        "step_archive/outputs/step030_설계선택.md",
        "step_archive/step030_레이아웃설계_chunk1.md",
        "step_archive/step030_전체설계_chunk1.md",
        "step_archive/outputs/step030_최종검증.md"
      ],
      requires: ["step029"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "design-alternatives", kind: "artifact", required: true, path: "step_archive/outputs/step030_설계대안.md" },
        { id: "design-selection", kind: "artifact", required: true, path: "step_archive/outputs/step030_설계선택.md" },
        { id: "layout-design-chunk-1", kind: "artifact", required: true, path: "step_archive/step030_레이아웃설계_chunk1.md" },
        { id: "overall-design-chunk-1", kind: "artifact", required: true, path: "step_archive/step030_전체설계_chunk1.md" },
        { id: "final-design-verification", kind: "artifact", required: true, path: "step_archive/outputs/step030_최종검증.md" },
        { id: "structured-brainstorming-first", kind: "check", required: true },
        { id: "independent-selector", kind: "check", required: true },
        { id: "class-architecture-contract", kind: "check", required: true },
        { id: "async-lifecycle-contract", kind: "check", required: true },
        { id: "responsive-accessibility-contract", kind: "check", required: true },
        { id: "design-exclusion-contract", kind: "check", required: true },
        { id: "design-chunks-bounded", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true }
      ],
      ported: true,
      next: "step031"
    }
  ]);
});

test("planning source hashes bind the reviewed source steps 025 through 030", async () => {
  const index = await loadIndex(repoRoot);
  const hashes = await recordSourceHashes(repoRoot, index.steps.slice(24, 30));

  assert.deepEqual(hashes, {
    step025: "0cc2be6f4cc2785c73bc836236a868915bb058c61532eac9abe235e48e438c0c",
    step026: "0bb2cb849d90f624ca2a5e28fe7e30f3cd41e342f3dbfb1b3b900cc869f5b288",
    step027: "fe4d854999ffb844df3ed0b08d9a19ae6f69b48dbcb9cab5568af87725661154",
    step028: "668fccf59d666c9f910db6db5f65f728296075c9b3b57a3d1c502b837173b0f0",
    step029: "1fd555a48ff56181aa51ec4b6c4ee35c6396fd78cfaa8d2e1ca6b2318782b5db",
    step030: "362a1eefab0c424fd66b3e18f1a7bb04285f64b55a281e8ab7ec93e3aa308076"
  });
});

test("planning acceptance descriptions reject placeholder-wide mutation", async () => {
  const index = await loadIndex(repoRoot);
  const mutated = structuredClone(index.steps.slice(24, 30));
  for (const step of mutated) {
    for (const item of step.acceptance) item.description = "x";
  }

  assert.throws(() => assertPlanningAcceptanceDescriptions(mutated));
});

test("planning documents bind exact frontmatter titles and only their current Step heading", async () => {
  const expected = [
    { name: "step025", number: 25, title: "기획: 전체 조사결과 기반 (독립 검증 루프)" },
    { name: "step026", number: 26, title: "기획 보강: GitHub 조사결과" },
    { name: "step027", number: 27, title: "기획 보강: API 계약 문서 조사결과" },
    { name: "step028", number: 28, title: "기획 보강: 참고 레포 코드 분석" },
    { name: "step029", number: 29, title: "기획 보강: Awwwards UX/UI·레이아웃 조사결과" },
    { name: "step030", number: 30, title: "통합 설계 (레이아웃 + 전체)" }
  ];

  for (const item of expected) {
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${item.name}.md`), "utf8");
    assert.deepEqual(parseStepDocument(content), {
      frontmatter: { name: item.name, phase: "planning" },
      titles: [{ number: item.number, title: item.title }],
      referencedSteps: [item.number]
    });
  }
});

test("planning outputs are immutable snapshots with required evidence and closed direct dependencies", async () => {
  const index = await loadIndex(repoRoot);
  const planning = (await validateStepBatch(repoRoot, [25, 26, 27, 28, 29, 30])).steps;
  const ownerByOutput = new Map(index.steps.flatMap((step) => (
    (step.outputs ?? []).map((output) => [output, step.id])
  )));
  const allOutputs = planning.flatMap((step) => step.outputs);

  assert.equal(new Set(allOutputs).size, allOutputs.length, "planning snapshots must never overwrite one another");
  for (const step of planning) {
    for (const output of step.outputs) {
      assert.ok(step.acceptance.some((item) => (
        item.kind === "artifact" && item.required && item.path === output
      )), `${step.id} output lacks required artifact evidence: ${output}`);
    }
    for (const input of step.inputs) {
      const owner = ownerByOutput.get(input);
      if (owner) assert.ok(step.requires.includes(owner), `${step.id} does not require the owner of ${input}`);
    }
    for (const dependency of step.requires) {
      assert.ok(step.inputs.some((input) => ownerByOutput.get(input) === dependency), `${step.id} has an unbound dependency ${dependency}`);
    }
  }

  assert.ok(planning.slice(1, 5).every((step) => !step.outputs.includes("step_archive/step025_planning_chunk1.md")));
});

test("planning instructions scope optional Jev, preserve permissions, and remain receipt-owned", async () => {
  const planning = (await validateStepBatch(repoRoot, [25, 26, 27, 28, 29, 30])).steps;

  for (const step of planning) {
    assert.equal(step.network, [25, 30].includes(step.number));
    const content = await readFile(join(repoRoot, step.target), "utf8");
    assert.deepEqual(scanForbiddenTokens(content), []);
    assert.doesNotMatch(content, /(?:progress|state)\.json|\.harness50-codex|transcript/i);
    assert.doesNotMatch(content, /\b(?:SessionStart|UserPromptSubmit|PreToolUse|Stop)\b|\bhooks?\b/i);
    assert.doesNotMatch(content, /(?:다음|후속)\s*(?:Step|단계)|\bnext\s+step\b/i);
    assertPlanningPermissionContract(content);
    assert.match(content, /수락 증거[^]*현재 단계에서 멈춘다/);
    assert.match(content, /workflow 상태와 영수증[^]*진행을 소유/);
  }
});

test("planning permission contracts reject contradictions and section-displaced assurances", async () => {
  const original = await readFile(join(repoRoot, "codex", "assets", "steps", "step025.md"), "utf8");
  const contradictions = [
    "안전 명령 자동 승인.",
    "안전 명령은 자동 승인한다.",
    "일반 명령을 자동 승인하라.",
    "권한 확인 우회.",
    "권한 확인 절차를 우회한다.",
    '"permissionDecision": "allow"',
    "permissionDecision = ask",
    "Auto-approve safe commands.",
    "Bypass permission checks.",
    "Use dangerously-bypass-approvals-and-sandbox."
  ];
  const permissionSentence = /어느 방식에서도 정상 권한 확인을 유지하고 자동\s+승인이나 권한 우회를 금지한다\./;
  assert.match(original, permissionSentence);
  const displaced = original
    .replace(permissionSentence, "")
    .replace(
      "## 입력과 산출물",
      "정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.\n\n## 입력과 산출물"
    );

  for (const directive of contradictions) {
    const contradictory = original.replace(
      "## 입력과 산출물",
      `${directive}\n\n## 입력과 산출물`
    );
    assert.throws(
      () => assertPlanningPermissionContract(contradictory),
      undefined,
      `contradictory permission directive escaped: ${directive}`
    );
  }
  assert.throws(() => assertPlanningPermissionContract(displaced));
});

test("every planning step separates a concrete author from an independent verifier honestly", async () => {
  const roleContracts = [
    { number: 25, author: /기초 기획 스냅샷 작성자 역할/, verifier: /조사 반영 독립 검증자 역할/ },
    { number: 26, author: /GitHub 근거 보강 작성자 역할/, verifier: /GitHub 근거 독립 검증자 역할/ },
    { number: 27, author: /API 계약 보강 작성자 역할/, verifier: /API 계약 독립 검증자 역할/ },
    { number: 28, author: /정적 구조 보강 작성자 역할/, verifier: /참고 코드 근거 독립 검증자 역할/ },
    { number: 29, author: /시각 기획 보강 작성자 역할/, verifier: /시각 근거 독립 검증자 역할/ },
    { number: 30, author: /설계 작성자 역할/, verifier: /최종 독립 검증자 역할/ }
  ];

  for (const { number, author, verifier } of roleContracts) {
    const id = `step${String(number).padStart(3, "0")}`;
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    const roleSection = /## 실행 역할\n([^]*?)(?=\n## )/.exec(content)?.[1];
    assert.ok(roleSection, `${id} is missing its role contract`);
    const normalized = roleSection.replace(/\s+/g, " ").trim();
    assert.match(normalized, author);
    assert.match(normalized, verifier);
    assert.match(normalized, /독립 검증자[^]*작성 산출물을 수정하지 않는다/);
    assert.match(normalized, /위임 기능을 사용할 수 없으면[^]*현재 실행자가[^]*역할을 명확히 분리[^]*순서대로 수행/);
    assert.match(normalized, /별도 역할을 위임했다고 기록하지 않는다/);
  }
});

test("steps 025 through 029 keep bounded PASS-only review rounds in one declared report each", async () => {
  const planning = (await validateStepBatch(repoRoot, [25, 26, 27, 28, 29])).steps;

  for (const step of planning) {
    const content = await readFile(join(repoRoot, step.target), "utf8");
    const report = `step_archive/outputs/${step.id}_검증.md`;
    const mentionedReports = [...new Set(
      [...content.matchAll(/`(step_archive\/outputs\/step0(?:25|26|27|28|29)_검증(?:_r\d+)?\.md)`/g)]
        .map((match) => match[1])
    )].filter((path) => path.includes(`/outputs/${step.id}_검증`));
    assert.deepEqual(mentionedReports, [report]);
    assert.match(content, /모든 라운드[^]*동일한 선언 보고서[^]*라운드별 섹션/);
    assert.match(content, /최대 5라운드/);
    assert.match(content, /`PASS`[^]*경우에만[^]*완료/);
    assert.match(content, /`FAIL`[^]*완료 증거[^]*될 수 없다/);
    assert.match(content, /5라운드[^]*`PASS`[^]*없으면[^]*차단/);
    assert.doesNotMatch(content, /_검증_r[2-5]\.md/);
  }
});

test("step025 bases a bounded, topic-complete snapshot on persisted general research", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step025.md"), "utf8");

  assert.match(content, /가장 먼저[^]*`step_archive\/TOPIC\/TOPIC\.md`/);
  assert.match(content, /`topic`[^]*`audience`[^]*`interactive`[^]*`real_world_apps`[^]*`constraints`/);
  assert.match(content, /step016_조사결과_chunk1\.md[^]*research-raw-step016-primary\.txt[^]*step016-primary\.png[^]*step024_검증_r1\.md/);
  assert.match(content, /데이터 반영[^]*누락[^]*왜곡[^]*출처 추적/);
  assert.match(content, /주제 일치[^]*타깃 적합성[^]*인터랙티브 충족[^]*사례 반영/);
  assert.match(content, /첫 청크 manifest[^]*500줄 이하/);
  assert.match(content, /실패와 해결[^]*`step_archive\/outputs\/step025_검증\.md`에만/);
  assert.doesNotMatch(content, /failure_patterns|스킵[^]*(?:완료|종료)/i);
});

test("steps 026 through 028 preserve source-specific evidence without rerunning untrusted work", async () => {
  const step26 = await readFile(join(repoRoot, "codex", "assets", "steps", "step026.md"), "utf8");
  const step27 = await readFile(join(repoRoot, "codex", "assets", "steps", "step027.md"), "utf8");
  const step28 = await readFile(join(repoRoot, "codex", "assets", "steps", "step028.md"), "utf8");

  assert.match(step26, /manifest에 보존된 성공 API 응답에 존재하는 후보와 사실만/);
  assert.match(step26, /새 API 요청[^]*금지/);
  assert.match(step26, /아키텍처[^]*패턴 결정[^]*출처 경로[^]*응답 항목/);
  assert.match(step26, /`exhausted-no-reference`[^]*검증된 빈 결정 목록[^]*no-reference 근거/);
  assert.match(step26, /독립 검증자가 이 대안을 확인하면 PASS 가능/);
  assert.match(step26, /검색 실패 또는 후보 복제 실패를 no-reference로 바꾸거나[^]*필수 검증을 면제할 수 없다/);

  assert.match(step27, /구체적인 계약 대상[^]*버전[^]*(?:endpoint|message)[^]*data schema/i);
  assert.match(step27, /필수 필드[^]*선택 필드[^]*인증[^]*rate limit[^]*오류[^]*재시도[^]*제한/);
  assert.match(step27, /원본에 없는 필드[^]*발명하지 않는다/);

  assert.match(step28, /격리 복제[^]*정적 분석/);
  assert.match(step28, /코드[^]*(?:실행|설치|빌드|테스트|자동화)[^]*금지/);
  assert.match(step28, /구조[^]*패턴[^]*제약[^]*복제 파일 경로[^]*줄 범위/);
  assert.match(step28, /`exhausted-no-reference`[^]*복제 기반 보강을 만들지 않고[^]*완전한 스냅샷을 유지/);
  assert.match(step28, /검증된 빈 결정 목록[^]*no-reference 근거/);
  assert.match(step28, /검색 실패 또는 후보 복제 실패를 no-reference로 바꾸거나[^]*필수 검증을 면제할 수 없다/);
});

test("step029 turns only inspected visual evidence into responsive accessible planning", async () => {
  const step = (await validateStepBatch(repoRoot, [29])).steps[0];
  const content = await readFile(join(repoRoot, step.target), "utf8");

  assert.equal(step.visual_review, true);
  assert.ok(step.acceptance.some((item) => (
    item.kind === "artifact" && item.required && item.path === "step_archive/screenshots/research/step022-primary-desktop.png"
  )));
  assert.ok(step.acceptance.some((item) => item.id === "visual-evidence-inspection" && item.required));
  assert.match(content, /실제로 열어[^]*manifest[^]*비교/);
  assert.match(content, /시각 검사 기능[^]*사용할 수 없으면[^]*완료하지 않는다/);
  assert.match(content, /실제로 이름이 붙은 조사 축[^]*근거 있는 대안만/);
  assert.match(content, /레이아웃[^]*UX\/UI[^]*인터랙션[^]*반응형[^]*텍스트 와이어프레임/);
  assert.match(content, /키보드[^]*포커스[^]*터치[^]*reduced-motion[^]*명암/);
});

test("step030 separates three alternatives, independent selection, final design, and verification", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step030.md"), "utf8");
  assertStep30SectionContract(content);
});

test("step030 preserves class, async lifecycle, performance, and accessibility contracts", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step030.md"), "utf8");
  const sections = assertStep30SectionContract(content);

  assert.ok(sections["Class 설계 계약"].length > 0);
  assert.ok(sections["비동기와 성능 계약"].length > 0);
  assert.ok(sections["레이아웃·상호작용·접근성 계약"].length > 0);
});

test("step030 rejects displaced, reordered, contradictory, and incomplete section semantics", async () => {
  const original = await readFile(join(repoRoot, "codex", "assets", "steps", "step030.md"), "utf8");
  const explorationHeading = "## 첫 설계 활동: 구조화된 대안 탐색";
  const explorationBody = extractMarkdownSection(original, "첫 설계 활동: 구조화된 대안 탐색");
  const archived = original.replace(
    explorationHeading,
    "## 보관된 비규범 참고 메모"
  );
  const deletedHeading = original.replace(`${explorationHeading}\n`, "");
  const displacedBody = original
    .replace(explorationBody, "규범적 대안 탐색 내용은 이 섹션에 없다.")
    .replace("## 완료 조건", `## 보관된 비규범 참고 메모\n\n${explorationBody}\n\n## 완료 조건`);
  const outOfOrder = original
    .replace("## 독립 선택", "## __TEMP_SELECTION__")
    .replace("## Class 설계 계약", "## 독립 선택")
    .replace("## __TEMP_SELECTION__", "## Class 설계 계약");
  const withoutContrast = original.replaceAll("명암", "시각적 구분");
  const namedExternalSkill = original.replace(
    explorationHeading,
    `${explorationHeading}\n\n먼저 Skill(skill="superpowers:brainstorming")에 의존한다.`
  );
  const asksUserOptions = original.replace(
    "사용자에게 옵션을 질문하지 않고",
    "사용자에게 옵션을 질문한다. 그런 뒤"
  );
  const performsImplementation = original.replace(
    /실제 구현이나\s+패키지 설치는 수행하지 않는다\./,
    "실제 구현과 패키지 설치를 수행한다."
  );
  const selectsMany = original.replace("정확히 하나만 선택", "여러 안을 선택");
  const splitVerificationReports = original.replaceAll(
    "step_archive/outputs/step030_최종검증.md",
    "step_archive/outputs/step030_최종검증_r2.md"
  );
  const unboundedVerification = original.replace(
    "최대 5라운드만 수행한다.",
    "필요한 만큼 반복한다."
  );

  for (const [name, mutation] of Object.entries({
    archived,
    deletedHeading,
    displacedBody,
    outOfOrder,
    withoutContrast,
    namedExternalSkill,
    asksUserOptions,
    performsImplementation,
    selectsMany,
    splitVerificationReports,
    unboundedVerification
  })) {
    assert.notEqual(mutation, original, `mutation did not change the document: ${name}`);
    assert.throws(
      () => assertStep30SectionContract(mutation),
      undefined,
      `step030 section mutation escaped: ${name}`
    );
  }
});

test("preflight documents bind exact frontmatter and titles to only their current step", async () => {
  const expected = [
    { name: "step001", phase: "preflight", number: 1, title: "하네스 프리플라이트 체크" },
    { name: "step002", phase: "preflight", number: 2, title: "프로젝트 분석 및 Context 전략 수립" },
    { name: "step003", phase: "preflight", number: 3, title: "브라우저 자동화 환경 확인" },
    { name: "step004", phase: "preflight", number: 4, title: "접근성 검사(axe) 환경 확인" },
    { name: "step005", phase: "preflight", number: 5, title: "c8 코드 커버리지 환경 설치" }
  ];

  for (const item of expected) {
    const content = await readFile(
      join(repoRoot, "codex", "assets", "steps", `${item.name}.md`),
      "utf8"
    );
    assert.deepEqual(parseStepDocument(content), {
      frontmatter: { name: item.name, phase: item.phase },
      titles: [{ number: item.number, title: item.title }],
      referencedSteps: [item.number]
    });
  }
});

test("step001 treats the topic artifact as immutable and fails closed when it is inadequate", async () => {
  const content = await readFile(
    join(repoRoot, "codex", "assets", "steps", "step001.md"),
    "utf8"
  );
  const topicSection = /## 1\. 튜토리얼 주제 점검\n([^]*?)\n## 2\./.exec(content)?.[1];

  assert.ok(topicSection, "step001 is missing its topic-input section");
  assert.match(topicSection, /읽기 전용\s+입력/);
  assert.match(topicSection, /절대 수정하지 않는다/);
  assert.match(topicSection, /누락되었거나[^]*불충분[^]*단계를 실패로 처리/);
  assert.match(topicSection, /파일 바이트를 변경하지 않은 채[^]*보고서/);
  assert.doesNotMatch(
    topicSection,
    /(?:기록한다|작성한다|생성한다|수정한다|보완한다|정규화한다|갱신한다|덮어쓴다)/
  );
  assert.doesNotMatch(
    topicSection,
    /\b(?:create|write|edit|amend|update|normalize|overwrite)\b/i
  );
  assert.doesNotMatch(
    topicSection,
    /(?:기록|작성|생성|보완|정규화|갱신|덮어쓰|업데이트)(?:한다|하라|하세요|해라|하십시오)/
  );
  assert.doesNotMatch(topicSection, /수정(?!하지|\s*금지)/);
});

test("step001 never accepts a diagnostic failure as required-tool evidence", async () => {
  const index = await loadIndex(repoRoot);
  const requiredInventory = index.steps[0].acceptance.find(
    (item) => item.id === "required-tool-inventory"
  );
  const content = await readFile(
    join(repoRoot, "codex", "assets", "steps", "step001.md"),
    "utf8"
  );

  assert.deepEqual(requiredInventory, {
    id: "required-tool-inventory",
    kind: "check",
    required: true,
    description: "Confirms every required tool is available after at most three permitted attempts; diagnostic failures never satisfy this acceptance."
  });
  assert.match(content, /필수 도구가 모두\s+실제로 사용 가능/);
  assert.match(content, /하나라도 사용할 수\s+없으면[^]*`required-tool-inventory`[^]*`ok: true`[^]*제출하지\s+않는다/);
  assert.match(content, /차단 또는 실패 보고서는 진단 자료일 뿐[^]*수락 증거가 아니다/);
  assert.match(content, /`SKIP`은 선택 도구에만 허용/);
  assert.doesNotMatch(
    content,
    /`required-tool-inventory`:[^\n]*(?:차단|실패)(?:\s|.){0,80}(?:충족|수락|완료)/
  );
});

test("validator rejects provider-specific and stale runtime tokens", () => {
  const diagnostics = scanForbiddenTokens(
    "Use Haiku, WebFetch, .claude/state and then read step081.md"
  );

  assert.deepEqual(diagnostics.map((item) => item.code), [
    "MODEL_SPECIFIC",
    "TOOL_SPECIFIC",
    "CLAUDE_PATH",
    "STALE_STEP"
  ]);
  assert.deepEqual(
    scanForbiddenTokens("run build-validator.ps1").map((item) => item.code),
    ["RETIRED_VALIDATOR"]
  );
  assert.deepEqual(
    scanForbiddenTokens("use read to inspect Step 81 and steps 69").map((item) => item.code),
    ["TOOL_SPECIFIC", "STALE_STEP"]
  );
});

test("index rejects invalid phases", () => {
  assert.throws(() => validateIndex({
    schema_version: 1,
    steps: Array.from({ length: 50 }, (_, offset) => entry(offset + 1, {
      phase: offset === 0 ? "unknown" : "preflight"
    }))
  }, { repoRoot, requirePorted: false }), /phase/);
});

test("index reports the missing number in a 50-row duplicate-number map", async () => {
  const index = await loadIndex(repoRoot);
  const invalid = structuredClone(index);
  invalid.steps[1] = structuredClone(invalid.steps[2]);

  assert.throws(
    () => validateIndex(invalid, { repoRoot, requirePorted: false }),
    /index has a gap at step 2/
  );
});

test("index rejects an invalid final next pointer", async () => {
  const index = await loadIndex(repoRoot);
  const invalid = structuredClone(index);
  invalid.steps.at(-1).next = "step001";

  assert.throws(
    () => validateIndex(invalid, { repoRoot, requirePorted: false }),
    /step050.next must be null/
  );
});

test("index rejects source drift without changing a Codex target", async () => {
  const index = await loadIndex(repoRoot);
  const invalid = structuredClone(index);
  invalid.steps[0].source_sha256 = "0".repeat(64);
  const targetPath = join(repoRoot, invalid.steps[0].target);
  const before = await readFile(targetPath);

  assert.throws(
    () => validateIndex(invalid, { repoRoot, requirePorted: false }),
    /SOURCE_CHANGED_REVIEW_REQUIRED/
  );
  assert.deepEqual(await readFile(targetPath), before);
});

test("unported entries do not require targets but ported entries require complete metadata", async () => {
  const root = await fixtureRoot();
  const source = join(root, "assets", "steps", "step001.md");
  await writeFile(source, "source bytes\n");
  const hash = (await recordSourceHashes(root, [entry(1)])).step001;
  const base = entry(1, {
    source_sha256: hash
  });
  const steps = Array.from({ length: 50 }, (_, offset) => {
    const number = offset + 1;
    return entry(number, number === 1 ? base : { source_sha256: hash });
  });
  for (const step of steps.slice(1)) {
    await writeFile(join(root, step.source), "source bytes\n");
  }

  assert.doesNotThrow(() => validateIndex({ schema_version: 1, steps }, {
    repoRoot: root,
    requirePorted: false
  }));

  assert.throws(() => validateIndex({
    schema_version: 1,
    steps: steps.map((step, index) => index === 0 ? { ...step, ported: true } : step)
  }, { repoRoot: root, requirePorted: true }), /missing Codex step/);

  await mkdir(join(root, "codex", "assets", "steps"), { recursive: true });
  for (const step of steps) {
    await writeFile(join(root, step.target), "safe Codex instructions\n");
  }
  assert.throws(() => validateIndex({
    schema_version: 1,
    steps: steps.map((step) => ({ ...step, ported: true }))
  }, { repoRoot: root, requirePorted: true }), /step001.inputs/);
});

test("ported entries require targets and final metadata even when requirePorted is false", async () => {
  const { root, index } = await portedFixture();
  await rm(join(root, index.steps[0].target));

  assert.throws(
    () => validateIndex(index, { repoRoot: root, requirePorted: false }),
    /missing Codex step/
  );

  await writeFile(join(root, index.steps[0].target), "Use available capabilities.\n");
  index.steps[0].inputs = undefined;

  assert.throws(
    () => validateIndex(index, { repoRoot: root, requirePorted: false }),
    /step001.inputs/
  );
});

test("ported artifact paths are constrained to the selected repository root", async () => {
  const { root, index } = await portedFixture({
    acceptance: [{
      id: "outside-artifact",
      kind: "artifact",
      required: true,
      description: "Stores a deterministic artifact.",
      path: "../outside-artifact.md"
    }]
  });

  assert.throws(
    () => validateIndex(index, { repoRoot: root, requirePorted: false }),
    /artifact path escapes the workspace/
  );
});

test("visual review requires a required screenshot artifact and required check", async () => {
  const { root, index } = await portedFixture({
    visualReview: true,
    acceptance: [
      {
        id: "screenshot-artifact",
        kind: "artifact",
        required: false,
        description: "Stores a screenshot.",
        path: "step_archive/screenshots/step001.png"
      },
      {
        id: "visual-check",
        kind: "check",
        required: false,
        description: "Records the inspection outcome."
      }
    ]
  });

  assert.throws(
    () => validateIndex(index, { repoRoot: root, requirePorted: false }),
    /required screenshot artifact and required check/
  );
});

test("ported batch validation rejects missing Codex files", async () => {
  const { root, index } = await portedFixture();
  await writeFile(
    join(root, "codex", "assets", "steps", "index.json"),
    `${JSON.stringify(index)}\n`
  );
  await rm(join(root, index.steps[0].target));

  await assert.rejects(
    () => validateStepBatch(root, [1]),
    /missing Codex step/
  );
});

const EXPECTED_IMPLEMENTATION_ACCEPTANCE_DESCRIPTIONS = {
  step031: {
    "environment-preparation-report": "Stores the selected-design, project-manifest, dependency, version, and smoke-check evidence.",
    "selected-design-and-manifests": "Confirms the selected Step 30 design and every present project manifest and lockfile were inspected.",
    "required-dependencies-only": "Confirms only dependencies required by the selected design were considered for installation.",
    "bounded-resolution-smoke": "Confirms every required dependency resolved, reported a version, and passed a bounded smoke check.",
    "permission-preservation": "Confirms conditional installation kept the normal permission flow and never auto-approved a command."
  },
  step032: {
    "implementation-file-index": "Stores the bounded file, Class, function, ownership, and dependency-order implementation map.",
    "selected-design-traceability": "Traces every planned file and symbol to the selected Step 30 design.",
    "bounded-file-ownership": "Confirms every work unit owns one to three files and each declared chunk is at most 500 lines.",
    "optional-tokei-disposition": "Records local tokei evidence or an explicit safe SKIP with deterministic fallback measurements.",
    "dependency-order": "Confirms new and modified files are ordered by their concrete implementation dependencies."
  },
  step033: {
    "jscpd-baseline-summary": "Stores the pre-implementation duplication baseline, tool disposition, and fallback evidence.",
    "jscpd-raw-report": "Stores raw JSON only when the already-local jscpd command succeeds.",
    "local-jscpd-command": "Runs only the already-local jscpd executable with network-disabled package execution.",
    "preimplementation-duplication-snapshot": "Confirms the baseline was captured before implementation changes.",
    "optional-jscpd-disposition": "Records either measured jscpd results or an explicit safe SKIP with a reason.",
    "duplication-fallback": "Records deterministic local fallback measurements when jscpd is unavailable."
  },
  step034: {
    "knip-baseline-summary": "Stores the pre-implementation unused-code baseline, tool disposition, and fallback evidence.",
    "knip-raw-report": "Stores raw JSON only when the already-local knip command succeeds.",
    "local-knip-command": "Runs only the already-local knip executable with network-disabled package execution.",
    "preimplementation-unused-code-snapshot": "Confirms the baseline was captured before implementation changes.",
    "optional-knip-disposition": "Records either measured knip results or an explicit safe SKIP with a reason.",
    "unused-code-fallback": "Records deterministic manifest and import-graph fallback evidence when knip is unavailable."
  },
  step035: {
    "context-policy": "Stores the bounded read, work-unit, checkpoint, and handoff policy used by later implementation.",
    "partial-inspection-policy": "Confirms large files use targeted discovery and bounded partial reads without blind rereads.",
    "small-work-units": "Confirms implementation work is divided into independently checkable one-to-three-file units.",
    "minimal-handoff": "Confirms each checkpoint and handoff contains only paths, decisions, evidence, blockers, and next work.",
    "no-token-balance-claim": "Confirms the policy never invents or claims observation of a hidden token balance."
  },
  step036: {
    "encoding-policy": "Stores the UTF-8-no-BOM, LF, final-newline audit and configuration-preservation evidence.",
    "utf8-lf-final-newline": "Confirms every touched text file is UTF-8 without BOM, uses LF, and ends with a newline.",
    "configuration-preservation": "Confirms existing encoding configuration was preserved and only minimally merged when needed.",
    "byte-level-verification": "Confirms encoding and line endings were verified from file bytes rather than display output.",
    "no-blind-rewrite": "Confirms only changed text files were corrected and binary or unrelated files were not rewritten."
  },
  step037: {
    "implementation-manifest": "Stores implemented files, digests, owners, tests, and traceability to the selected design and topic.",
    "implementation-screenshot-input": "Requires the persisted Step 22 Awwwards screenshot inspected for CSS evidence.",
    "topic-field-fidelity": "Confirms topic, audience, interactive, real-world application, and constraint fields are reflected without modifying TOPIC.",
    "selected-design-only": "Confirms implementation follows only the selected Step 30 design without reopening selection.",
    "class-async-accessibility": "Confirms Class boundaries, asynchronous lifecycle, interactions, and accessibility contracts are implemented.",
    "incremental-test-evidence": "Confirms each owned module was implemented through a failing-test, minimal-change, passing-test cycle.",
    "visual-evidence-inspection": "Confirms the required screenshot was actually opened and CSS decisions trace to observed regions.",
    "independent-implementation-verifier": "Confirms a non-modifying independent verification pass checked the implementation and manifest."
  },
  step038: {
    "build-smoke-report": "Stores the exact build, dist HTML, zero-cycle, and advisory diagnostic results.",
    "implementation-milestone": "Stores the first 38-step quality milestone only after both mandatory gates pass.",
    "dist-index-html": "Requires the build-produced dist/index.html artifact.",
    "project-build-command": "Runs the exact non-optional build script declared by the project manifest.",
    "dist-html-boundary": "Confirms dist/index.html is a regular nonempty file with opening and closing HTML boundaries.",
    "zero-cycle-gate": "Confirms a declared local cycle tool or deterministic local fallback reports zero cycles.",
    "advisory-diagnostics": "Records lint, formatting, and type diagnostics without substituting for either mandatory gate.",
    "pass-only-build-gate": "Confirms both mandatory gates passed before the report and milestone count as completion evidence.",
    "measured-quality-report": "Runtime-populated current measured-quality PASS with validated immutable report digest; required for every new completion."
  }
};

function assertImplementationAcceptanceDescriptions(steps) {
  const actual = Object.fromEntries(steps.map((step) => [
    step.id,
    Object.fromEntries(step.acceptance.map((item) => [item.id, item.description]))
  ]));
  assert.deepEqual(actual, EXPECTED_IMPLEMENTATION_ACCEPTANCE_DESCRIPTIONS);
}

const IMPLEMENTATION_ROLE_CONTRACTS = [
  { number: 31, worker: /환경 준비 실행자 역할/, verifier: /환경 준비 독립 검증자 역할/ },
  { number: 32, worker: /파일 인덱스 작성자 역할/, verifier: /파일 인덱스 독립 검증자 역할/ },
  { number: 33, worker: /중복 베이스라인 실행자 역할/, verifier: /중복 베이스라인 독립 검증자 역할/ },
  { number: 34, worker: /미사용 코드 베이스라인 실행자 역할/, verifier: /미사용 코드 베이스라인 독립 검증자 역할/ },
  { number: 36, worker: /인코딩 정책 작성자 역할/, verifier: /인코딩 독립 검증자 역할/ },
  { number: 37, worker: /모듈 구현자 역할/, verifier: /구현 독립 검증자 역할/ },
  { number: 38, worker: /빌드 게이트 실행자 역할/, verifier: /빌드 게이트 독립 검증자 역할/ }
];

function assertImplementationRoleContract(content, { worker, verifier }) {
  const roleSection = extractMarkdownSection(content, "실행 역할").replace(/\s+/g, " ");
  assert.match(roleSection, worker);
  assert.match(roleSection, verifier);
  assert.match(roleSection, /독립 검증자[^]*산출물을 수정하지 않는다/);
  assert.match(roleSection, /위임 기능을 사용할 수 없으면[^]*현재 실행자가[^]*두 역할을 명확히 분리[^]*순서대로 수행/);
  assert.match(roleSection, /별도 역할을 위임했다고 기록하지 않는다/);
  assertPlanningPermissionContract(content);
}

function assertStep35RoleContract(content) {
  const roleSection = extractMarkdownSection(content, "실행 역할").replace(/\s+/g, " ");
  assert.match(roleSection, /이 단계에서는 외부 역할에 위임하지 않는다/);
  assert.match(roleSection, /현재 실행자가 정책 수립 패스[^]*분리된 검증 패스[^]*순서대로 수행/);
  assert.match(roleSection, /검증 패스[^]*정책 산출물을 수정하지 않는다/);
  assert.match(roleSection, /별도 역할을 위임했다고 기록하지 않는다/);
  assertPlanningPermissionContract(content);
}

const EXPECTED_IMPLEMENTATION_TARGET_SHA256 = Object.freeze({
  step031: "b62943f7f14298d4179b077c3e6efc7cac5a30a2e1b65d7337d8d42913eaa0be",
  step032: "96b2b78bbf8968198e43bbb2edba5f58ab41e9e01bef20d8d9270c73e44d54e7",
  step033: "f4521275e7f409d858c4fad64fe71645e924fdd9aa4ab9d957d28ccc1cb4a945",
  step034: "28ccaea5e66abc407ed9ad0f1543c2c989b9bcdd4648580e5e252131605d7892",
  step035: "9db05334af746fe8e0f02bac6ba1f9c4fce56855adbad3667ff30a8d1b65e249",
  step036: "309f1fc4c9ab8f7d23eb31b8d37d5648ce35e274154f4e70ffd7213cb4f05c7e",
  step037: "241f4e199ffa3567fa1b84c5e973223ea6789e854af2714688fc0221d373fffd",
  step038: "dae26106a224c11fdf7becbd6941659569bcd182e1c2b9909962bacd156e5198"
});

async function assertImplementationTargetDigests(root) {
  for (const [id, expected] of Object.entries(EXPECTED_IMPLEMENTATION_TARGET_SHA256)) {
    const relativePath = `codex/assets/steps/${id}.md`;
    let bytes;
    try {
      bytes = await readFile(join(root, relativePath));
    } catch (error) {
      const actual = `unreadable:${error?.code ?? "unknown"}`;
      throw new Error(`${id} target digest mismatch: path=${relativePath} expected=${expected} actual=${actual}`);
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      throw new Error(`${id} target digest mismatch: path=${relativePath} expected=${expected} actual=${actual}`);
    }
  }
}

test("implementation batch declares the exact Codex-native evidence contracts", async () => {
  await assertImplementationTargetDigests(repoRoot);
  const report = await validateStepBatch(repoRoot, [31, 32, 33, 34, 35, 36, 37, 38]);
  assertImplementationAcceptanceDescriptions(report.steps);
  const projected = report.steps.map((step) => ({
    number: step.number,
    id: step.id,
    title: step.title,
    phase: step.phase,
    source: step.source,
    target: step.target,
    source_sha256: step.source_sha256,
    inputs: step.inputs,
    outputs: step.outputs,
    requires: step.requires,
    optional_requires: step.optional_requires,
    network: step.network,
    visual_review: step.visual_review,
    acceptance: step.acceptance.map((item) => ({
      id: item.id,
      kind: item.kind,
      required: item.required,
      ...(item.path === undefined ? {} : { path: item.path }),
      ...(item.command_pattern === undefined ? {} : { command_pattern: item.command_pattern })
    })),
    ported: step.ported,
    next: step.next
  }));

  assert.deepEqual(projected, [
    {
      number: 31,
      id: "step031",
      title: "환경 준비",
      phase: "implementation",
      source: "assets/steps/step031.md",
      target: "codex/assets/steps/step031.md",
      source_sha256: "6a59cd2c9d191a467a6631ce1439572476a96d54ad11c3b9f44e61cd87b3dc4f",
      inputs: [
        "step_archive/outputs/step030_설계선택.md",
        "step_archive/step030_레이아웃설계_chunk1.md",
        "step_archive/step030_전체설계_chunk1.md"
      ],
      outputs: ["step_archive/step031_환경준비.md"],
      requires: ["step030"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "environment-preparation-report", kind: "artifact", required: true, path: "step_archive/step031_환경준비.md" },
        { id: "selected-design-and-manifests", kind: "check", required: true },
        { id: "required-dependencies-only", kind: "check", required: true },
        { id: "bounded-resolution-smoke", kind: "check", required: true },
        { id: "permission-preservation", kind: "check", required: true }
      ],
      ported: true,
      next: "step032"
    },
    {
      number: 32,
      id: "step032",
      title: "구현 파일 인덱싱 (tokei)",
      phase: "implementation",
      source: "assets/steps/step032.md",
      target: "codex/assets/steps/step032.md",
      source_sha256: "a94cb387abd7269c81d22cacd62deec1b7d3e9c585b8294df94fd4e9ed3989b0",
      inputs: [
        "step_archive/step030_레이아웃설계_chunk1.md",
        "step_archive/step030_전체설계_chunk1.md",
        "step_archive/step031_환경준비.md"
      ],
      outputs: ["step_archive/step032_파일인덱스_chunk1.md"],
      requires: ["step030", "step031"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "implementation-file-index", kind: "artifact", required: true, path: "step_archive/step032_파일인덱스_chunk1.md" },
        { id: "selected-design-traceability", kind: "check", required: true },
        { id: "bounded-file-ownership", kind: "check", required: true },
        { id: "optional-tokei-disposition", kind: "check", required: true },
        { id: "dependency-order", kind: "check", required: true }
      ],
      ported: true,
      next: "step033"
    },
    {
      number: 33,
      id: "step033",
      title: "jscpd 코드 중복 베이스라인 수집",
      phase: "implementation",
      source: "assets/steps/step033.md",
      target: "codex/assets/steps/step033.md",
      source_sha256: "87c3fc9ecdceb656ce18da6550f4acffb8551078deecb19a8f23617e977192d4",
      inputs: ["step_archive/step032_파일인덱스_chunk1.md"],
      outputs: ["step_archive/step033_jscpd베이스라인.md"],
      requires: ["step032"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "jscpd-baseline-summary", kind: "artifact", required: true, path: "step_archive/step033_jscpd베이스라인.md" },
        { id: "jscpd-raw-report", kind: "artifact", required: false, path: "step_archive/jscpd-baseline/jscpd-report.json" },
        { id: "local-jscpd-command", kind: "command", required: false, command_pattern: "^npm exec --offline -- jscpd src/ --reporters json --output step_archive/jscpd-baseline/$" },
        { id: "preimplementation-duplication-snapshot", kind: "check", required: true },
        { id: "optional-jscpd-disposition", kind: "check", required: true },
        { id: "duplication-fallback", kind: "check", required: true }
      ],
      ported: true,
      next: "step034"
    },
    {
      number: 34,
      id: "step034",
      title: "knip 미사용 코드 베이스라인 수집",
      phase: "implementation",
      source: "assets/steps/step034.md",
      target: "codex/assets/steps/step034.md",
      source_sha256: "c28f7b8f168135793d8e982441ed89888adc216bbaaf7185581d763c0a383c68",
      inputs: ["step_archive/step032_파일인덱스_chunk1.md"],
      outputs: ["step_archive/step034_knip베이스라인.md"],
      requires: ["step032"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "knip-baseline-summary", kind: "artifact", required: true, path: "step_archive/step034_knip베이스라인.md" },
        { id: "knip-raw-report", kind: "artifact", required: false, path: "step_archive/knip-baseline.json" },
        { id: "local-knip-command", kind: "command", required: false, command_pattern: "^npm exec --offline -- knip --reporter json$" },
        { id: "preimplementation-unused-code-snapshot", kind: "check", required: true },
        { id: "optional-knip-disposition", kind: "check", required: true },
        { id: "unused-code-fallback", kind: "check", required: true }
      ],
      ported: true,
      next: "step035"
    },
    {
      number: 35,
      id: "step035",
      title: "컨텍스트 윈도우 제한 방지",
      phase: "implementation",
      source: "assets/steps/step035.md",
      target: "codex/assets/steps/step035.md",
      source_sha256: "664d663cc7ed8cbb8605e3c5c5d2653fb139421eb469e81d1f08201fbf284acd",
      inputs: ["step_archive/step032_파일인덱스_chunk1.md"],
      outputs: ["step_archive/step035_컨텍스트정책.md"],
      requires: ["step032"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "context-policy", kind: "artifact", required: true, path: "step_archive/step035_컨텍스트정책.md" },
        { id: "partial-inspection-policy", kind: "check", required: true },
        { id: "small-work-units", kind: "check", required: true },
        { id: "minimal-handoff", kind: "check", required: true },
        { id: "no-token-balance-claim", kind: "check", required: true }
      ],
      ported: true,
      next: "step036"
    },
    {
      number: 36,
      id: "step036",
      title: "인코딩 규칙 (모지바케 방지)",
      phase: "implementation",
      source: "assets/steps/step036.md",
      target: "codex/assets/steps/step036.md",
      source_sha256: "29ef9de9458af31433321b92d4ce8ec68a201cd29714195dca04b514130e37b7",
      inputs: ["step_archive/step032_파일인덱스_chunk1.md", "step_archive/step035_컨텍스트정책.md"],
      outputs: ["step_archive/step036_인코딩정책.md"],
      requires: ["step032", "step035"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "encoding-policy", kind: "artifact", required: true, path: "step_archive/step036_인코딩정책.md" },
        { id: "utf8-lf-final-newline", kind: "check", required: true },
        { id: "configuration-preservation", kind: "check", required: true },
        { id: "byte-level-verification", kind: "check", required: true },
        { id: "no-blind-rewrite", kind: "check", required: true }
      ],
      ported: true,
      next: "step037"
    },
    {
      number: 37,
      id: "step037",
      title: "구현",
      phase: "implementation",
      source: "assets/steps/step037.md",
      target: "codex/assets/steps/step037.md",
      source_sha256: "7cd1c1a434257be3e233191fc532119e83824504b8830a55f380ac6cb786475a",
      inputs: [
        "step_archive/outputs/step024_검증_r1.md",
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step022_수집결과_chunk1.md",
        "step_archive/awwwards-step022-primary.txt",
        "step_archive/screenshots/research/step022-primary-desktop.png",
        "step_archive/step023_조사결과_chunk1.md",
        "step_archive/outputs/step030_설계선택.md",
        "step_archive/step030_레이아웃설계_chunk1.md",
        "step_archive/step030_전체설계_chunk1.md",
        "step_archive/step031_환경준비.md",
        "step_archive/step032_파일인덱스_chunk1.md",
        "step_archive/step035_컨텍스트정책.md",
        "step_archive/step036_인코딩정책.md"
      ],
      outputs: ["step_archive/step037_구현manifest.md"],
      requires: ["step024", "step022", "step023", "step030", "step031", "step032", "step035", "step036"],
      optional_requires: [],
      network: true,
      visual_review: true,
      acceptance: [
        { id: "implementation-manifest", kind: "artifact", required: true, path: "step_archive/step037_구현manifest.md" },
        { id: "implementation-screenshot-input", kind: "artifact", required: true, path: "step_archive/screenshots/research/step022-primary-desktop.png" },
        { id: "topic-field-fidelity", kind: "check", required: true },
        { id: "selected-design-only", kind: "check", required: true },
        { id: "class-async-accessibility", kind: "check", required: true },
        { id: "incremental-test-evidence", kind: "check", required: true },
        { id: "visual-evidence-inspection", kind: "check", required: true },
        { id: "independent-implementation-verifier", kind: "check", required: true }
      ],
      ported: true,
      next: "step038"
    },
    {
      number: 38,
      id: "step038",
      title: "빌드 스모크 테스트 (구현 완료 게이트)",
      phase: "implementation",
      source: "assets/steps/step038.md",
      target: "codex/assets/steps/step038.md",
      source_sha256: "7fa7ace3ec7c9eb0fa6d3967f7d92dc5e3b4acaa6736f8d65934fc19219ecd6e",
      inputs: [
        "step_archive/step031_환경준비.md",
        "step_archive/step033_jscpd베이스라인.md",
        "step_archive/step034_knip베이스라인.md",
        "step_archive/step037_구현manifest.md"
      ],
      outputs: ["step_archive/step038_smoke_test.md", "step_archive/outputs/trust5_r1.md", "dist/index.html"],
      requires: ["step031", "step033", "step034", "step037"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "build-smoke-report", kind: "artifact", required: true, path: "step_archive/step038_smoke_test.md" },
        { id: "implementation-milestone", kind: "artifact", required: true, path: "step_archive/outputs/trust5_r1.md" },
        { id: "dist-index-html", kind: "artifact", required: true, path: "dist/index.html" },
        { id: "project-build-command", kind: "command", required: true, command_pattern: "^(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run) (?:build|[A-Za-z0-9][A-Za-z0-9:_-]*build[A-Za-z0-9:_-]*)$" },
        { id: "dist-html-boundary", kind: "check", required: true },
        { id: "zero-cycle-gate", kind: "check", required: true },
        { id: "advisory-diagnostics", kind: "check", required: true },
        { id: "pass-only-build-gate", kind: "check", required: true },
        { id: "measured-quality-report", kind: "check", required: false }
      ],
      ported: true,
      next: "step039"
    }
  ]);
});

test("implementation source hashes bind the reviewed source steps 031 through 038", async () => {
  const index = await loadIndex(repoRoot);
  const hashes = await recordSourceHashes(repoRoot, index.steps.slice(30, 38));

  assert.deepEqual(hashes, {
    step031: "6a59cd2c9d191a467a6631ce1439572476a96d54ad11c3b9f44e61cd87b3dc4f",
    step032: "a94cb387abd7269c81d22cacd62deec1b7d3e9c585b8294df94fd4e9ed3989b0",
    step033: "87c3fc9ecdceb656ce18da6550f4acffb8551078deecb19a8f23617e977192d4",
    step034: "c28f7b8f168135793d8e982441ed89888adc216bbaaf7185581d763c0a383c68",
    step035: "664d663cc7ed8cbb8605e3c5c5d2653fb139421eb469e81d1f08201fbf284acd",
    step036: "29ef9de9458af31433321b92d4ce8ec68a201cd29714195dca04b514130e37b7",
    step037: "7cd1c1a434257be3e233191fc532119e83824504b8830a55f380ac6cb786475a",
    step038: "7fa7ace3ec7c9eb0fa6d3967f7d92dc5e3b4acaa6736f8d65934fc19219ecd6e"
  });
});

test("implementation acceptance descriptions reject placeholder-wide mutation", async () => {
  const index = await loadIndex(repoRoot);
  const mutated = structuredClone(index.steps.slice(30, 38));
  for (const step of mutated) {
    for (const item of step.acceptance ?? []) item.description = "x";
  }

  assert.throws(() => assertImplementationAcceptanceDescriptions(mutated));
});

test("implementation documents bind exact frontmatter titles and only their current Step heading", async () => {
  const expected = [
    { name: "step031", number: 31, title: "환경 준비" },
    { name: "step032", number: 32, title: "구현 파일 인덱싱 (tokei)" },
    { name: "step033", number: 33, title: "jscpd 코드 중복 베이스라인 수집" },
    { name: "step034", number: 34, title: "knip 미사용 코드 베이스라인 수집" },
    { name: "step035", number: 35, title: "컨텍스트 윈도우 제한 방지" },
    { name: "step036", number: 36, title: "인코딩 규칙 (모지바케 방지)" },
    { name: "step037", number: 37, title: "구현" },
    { name: "step038", number: 38, title: "빌드 스모크 테스트 (구현 완료 게이트)" }
  ];

  for (const item of expected) {
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${item.name}.md`), "utf8");
    assert.deepEqual(parseStepDocument(content), {
      frontmatter: { name: item.name, phase: "implementation" },
      titles: [{ number: item.number, title: item.title }],
      referencedSteps: [item.number]
    });
  }
});

test("implementation outputs are unique required artifacts with closed direct dependencies", async () => {
  const index = await loadIndex(repoRoot);
  const implementation = (await validateStepBatch(repoRoot, [31, 32, 33, 34, 35, 36, 37, 38])).steps;
  const ownersByOutput = new Map();
  for (const step of index.steps) {
    for (const output of step.outputs ?? []) {
      const owners = ownersByOutput.get(output) ?? [];
      owners.push(step.id);
      ownersByOutput.set(output, owners);
    }
  }
  const ownerByOutput = new Map(
    [...ownersByOutput].map(([output, owners]) => [output, owners.length === 1 ? owners[0] : null])
  );
  const allOutputs = implementation.flatMap((step) => step.outputs);

  assert.equal(new Set(allOutputs).size, allOutputs.length);
  for (const step of implementation) {
    for (const output of step.outputs) {
      assert.deepEqual(ownersByOutput.get(output), [step.id], `${output} must have exactly one canonical owner`);
      assert.ok(step.acceptance.some((item) => (
        item.kind === "artifact" && item.required && item.path === output
      )), `${step.id} output lacks required artifact evidence: ${output}`);
    }
    for (const input of step.inputs) {
      const owner = ownerByOutput.get(input);
      if (owner) assert.ok(step.requires.includes(owner), `${step.id} does not require the owner of ${input}`);
    }
    for (const dependency of step.requires) {
      assert.ok(step.inputs.some((input) => ownerByOutput.get(input) === dependency), `${step.id} has an unbound dependency ${dependency}`);
    }
  }
});

test("implementation instructions stay provider-neutral, permission-preserving, and receipt-owned", async () => {
  const implementation = (await validateStepBatch(repoRoot, [31, 32, 33, 34, 35, 36, 37, 38])).steps;

  for (const step of implementation) {
    const content = await readFile(join(repoRoot, step.target), "utf8");
    assert.deepEqual(scanForbiddenTokens(content), []);
    assert.doesNotMatch(content, /(?:progress|state)\.json|\.harness50-codex|transcript/i);
    assert.doesNotMatch(content, /\/(?:webapp|harness-status|harness-reset)\b|\$(?:webapp|harness(?:14|20|36|50)-(?:status|reset))\b/i);
    assert.doesNotMatch(content, /\b(?:SessionStart|UserPromptSubmit|PreToolUse|Stop)\b|\bhooks?\b/i);
    assert.doesNotMatch(content, /(?:다음|후속)\s*(?:Step|단계)|\bnext\s+step\b/i);
    assertPlanningPermissionContract(content);
    const normalized = content.replace(/\s+/g, " ");
    assert.match(normalized, /수락 증거[^]*현재 단계에서 멈춘다/);
    assert.match(normalized, /workflow 상태와 영수증[^]*진행을 소유/);
  }
});

test("implementation target digest seal rejects unsafe and benign byte mutations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness50-implementation-digests-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "codex", "assets", "steps"), { recursive: true });

  const cases = [
    [31, "Although the smoke check fails, the step may be completed successfully."],
    [32, "Overlapping file ownership is acceptable and the dependency order may remain open."],
    [33, "When local jscpd is absent, fetch it from the remote registry."],
    [34, "When local knip is absent, fetch it from the remote registry."],
    [35, "Report the hidden token balance as observed."],
    [36, "CRLF and BOM are permitted for every changed file."],
    [37, "Skip opening the screenshot and still record PASS."],
    [38, "Although the build fails, declare the milestone complete."]
  ];
  const originals = new Map();

  for (const [number] of cases) {
    const id = `step${String(number).padStart(3, "0")}`;
    const relativePath = `codex/assets/steps/${id}.md`;
    const bytes = await readFile(join(repoRoot, relativePath));
    originals.set(id, bytes);
    await writeFile(join(root, relativePath), bytes);
  }

  const escaped = [];
  const wrongDiagnostics = [];
  for (const [number, contradiction] of cases) {
    const id = `step${String(number).padStart(3, "0")}`;
    const relativePath = `codex/assets/steps/${id}.md`;
    const original = originals.get(id);
    const mutations = [
      ["unsafe-contradiction", Buffer.concat([original, Buffer.from(`\n${contradiction}\n`)])],
      ["benign-whitespace", Buffer.concat([original, Buffer.from("\n")])]
    ];

    for (const [name, mutated] of mutations) {
      await writeFile(join(root, relativePath), mutated);
      const actual = createHash("sha256").update(mutated).digest("hex");
      const expectedMessage = `${id} target digest mismatch: path=${relativePath} expected=${EXPECTED_IMPLEMENTATION_TARGET_SHA256[id]} actual=${actual}`;
      try {
        await assertImplementationTargetDigests(root);
        escaped.push(`${id}:${name}`);
      } catch (error) {
        if (error.message !== expectedMessage) {
          wrongDiagnostics.push(`${id}:${name}:${error.message}`);
        }
      } finally {
        await writeFile(join(root, relativePath), original);
      }
    }
  }

  assert.deepEqual({ escaped, wrongDiagnostics }, { escaped: [], wrongDiagnostics: [] });
});

test("implementation roles are concrete, independently verified, and truthfully fall back", async () => {
  for (const contract of IMPLEMENTATION_ROLE_CONTRACTS) {
    const id = `step${String(contract.number).padStart(3, "0")}`;
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    assertImplementationRoleContract(content, contract);
  }

  const step35 = await readFile(join(repoRoot, "codex", "assets", "steps", "step035.md"), "utf8");
  assertStep35RoleContract(step35);
});

test("implementation role and permission checks reject per-step removals and contradictions", async () => {
  for (const contract of IMPLEMENTATION_ROLE_CONTRACTS) {
    const id = `step${String(contract.number).padStart(3, "0")}`;
    const original = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    const workerRemoved = original.replace(contract.worker, "삭제된 실행 역할");
    const verifierRemoved = original.replace(contract.verifier, "삭제된 검증 역할");
    const fallbackRemoved = original.replace(/위임 기능을\s*사용할 수 없으면[^.]+\./, "위임할 수 없으면 그대로 완료한다.");
    const contradiction = original.replace("## 입력과 산출물", "안전 명령은 자동 승인한다.\n\n## 입력과 산출물");

    for (const [name, mutation] of Object.entries({ workerRemoved, verifierRemoved, fallbackRemoved, contradiction })) {
      assert.notEqual(mutation, original, `${id} mutation did not change content: ${name}`);
      assert.throws(
        () => assertImplementationRoleContract(mutation, contract),
        undefined,
        `${id} role mutation escaped: ${name}`
      );
    }
  }

  const step35 = await readFile(join(repoRoot, "codex", "assets", "steps", "step035.md"), "utf8");
  for (const [name, mutation] of Object.entries({
    delegated: step35.replace("이 단계에서는 외부 역할에 위임하지 않는다", "이 단계는 외부 역할에 위임한다"),
    mergedPass: step35.replace(/분리된\s*검증 패스/, "같은 정책 수립 패스"),
    contradiction: step35.replace("## 입력과 산출물", "권한 확인 절차를 우회한다.\n\n## 입력과 산출물")
  })) {
    assert.notEqual(mutation, step35, `step035 mutation did not change content: ${name}`);
    assert.throws(() => assertStep35RoleContract(mutation), undefined, `step035 mutation escaped: ${name}`);
  }
});

test("step031 installs only required dependencies through bounded normal-permission checks", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step031.md"), "utf8");
  const section = extractMarkdownSection(content, "환경 확인과 설치").replace(/\s+/g, " ");

  assert.match(section, /설계선택[^]*레이아웃설계[^]*전체설계/);
  assert.match(section, /manifest[^]*lockfile/i);
  assert.match(section, /선택된 설계에 필수인 프로젝트 의존성만/);
  assert.match(section, /최대 3회/);
  assert.match(section, /resolve[^]*version[^]*smoke/i);
  assert.match(section, /실패[^]*차단/);
  assert.doesNotMatch(content, /dependency-checker|자동 설치|설치 없이[^]*완료/i);
});

test("step032 creates a bounded dependency-ordered file and symbol ownership map", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step032.md"), "utf8");
  const section = extractMarkdownSection(content, "파일 인덱스 작성").replace(/\s+/g, " ");

  assert.match(section, /파일[^]*Class[^]*함수/);
  assert.match(section, /신규[^]*수정/);
  assert.match(section, /의존성 순서/);
  assert.match(section, /1~3개 파일/);
  assert.match(section, /500줄 이하/);
  assert.match(section, /로컬 `tokei`[^]*선택 사항/);
  assert.match(section, /없으면[^]*`SKIP`[^]*안전한 파일 열거[^]*줄 수/);
  assert.doesNotMatch(section, /(?:설치|다운로드)[^]*(?:tokei)|npx/i);
});

test("steps033 and 034 keep optional baselines local and preserve mandatory summaries", async () => {
  const cases = [
    {
      id: "step033",
      heading: "선택적 jscpd 베이스라인",
      tool: "jscpd",
      summary: "step_archive/step033_jscpd베이스라인.md",
      raw: "step_archive/jscpd-baseline/jscpd-report.json",
      fallback: /중복[^]*fallback/i
    },
    {
      id: "step034",
      heading: "선택적 knip 베이스라인",
      tool: "knip",
      summary: "step_archive/step034_knip베이스라인.md",
      raw: "step_archive/knip-baseline.json",
      fallback: /manifest[^]*import[^]*fallback/i
    }
  ];

  for (const item of cases) {
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${item.id}.md`), "utf8");
    const section = extractMarkdownSection(content, item.heading).replace(/\s+/g, " ");
    assert.match(section, /구현 변경 전/);
    assert.match(section, new RegExp(`로컬[^]*${item.tool}`));
    assert.match(section, /네트워크[^]*사용하지 않는다/);
    assert.match(section, /없으면[^]*`SKIP`[^]*이유/);
    assert.match(section, item.fallback);
    assert.match(section, new RegExp(item.summary.replaceAll("/", "\\/")));
    assert.match(section, new RegExp(item.raw.replaceAll("/", "\\/")));
    assert.match(section, /원시 JSON[^]*성공한 경우에만[^]*선택적/);
    assert.doesNotMatch(content, /\bnpx\b|(?:설치|다운로드)[^]*(?:jscpd|knip)/i);
  }
});

test("step035 defines bounded reads, small work units, checkpoints, and honest handoffs", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step035.md"), "utf8");
  const section = extractMarkdownSection(content, "컨텍스트 정책").replace(/\s+/g, " ");

  assert.match(section, /필요한 범위만 부분적으로 읽/);
  assert.match(section, /읽은 범위[^]*다시 읽지 않는다/);
  assert.match(section, /1~3개 파일/);
  assert.match(section, /체크포인트/);
  assert.match(section, /경로[^]*결정[^]*증거[^]*차단 요인[^]*다음 작업/);
  assert.match(section, /토큰 잔량[^]*관찰했다고 주장하지 않는다/);
  assert.doesNotMatch(section, /토큰[^]*(?:\d+%|남았다|확인했다|측정했다)/);
});

test("step036 enforces byte-verified UTF-8 LF without destructive configuration rewrites", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step036.md"), "utf8");
  const section = extractMarkdownSection(content, "인코딩 정책").replace(/\s+/g, " ");

  assert.match(section, /UTF-8[^]*BOM 없음[^]*LF[^]*마지막 줄바꿈/);
  assert.match(section, /바이트[^]*검증/);
  assert.match(section, /\.editorconfig[^]*\.gitattributes[^]*보존[^]*병합/);
  assert.match(section, /변경한 텍스트 파일만[^]*바이너리[^]*재작성하지 않는다/);
  assert.doesNotMatch(content, /Set-Content[^\n]*-Encoding\s+UTF8|무조건[^]*(?:덮어쓰|재작성)/i);
});

function assertStep37ImplementationContract(content) {
  const section = extractMarkdownSection(content, "선택 설계 구현").replace(/\s+/g, " ");
  assert.match(section, /TOPIC\.md[^]*수정하지 않는다/);
  assert.match(section, /`topic`[^]*`audience`[^]*`interactive`[^]*`real_world_apps`[^]*`constraints`/);
  assert.match(section, /선택된 30단계 설계만[^]*다시 선택하지 않는다/);
  assert.match(section, /파일\/모듈 소유권[^]*1~3개 파일/);
  assert.match(section, /실패하는 테스트[^]*최소 구현[^]*통과[^]*리팩터링/);
  assert.match(section, /Class[^]*async[^]*접근성/);
  assert.match(section, /step022-primary-desktop\.png[^]*실제로 열어[^]*CSS[^]*화면 영역/);
  assert.match(section, /시각 검사 기능[^]*사용할 수 없으면[^]*차단/);
  assert.match(section, /구현manifest\.md[^]*파일[^]*digest[^]*요구 추적/);
  assert.match(section, /`harness50-design-contract` `tokens`로만[^]*`adopted`가 false[^]*구현하지 않는다\(목록 우선\)/);
  assert.doesNotMatch(section, /(?:브레인스토밍|brainstorm)|대안을 새로|선택을 변경/i);
}

test("step037 implements only the selected topic-complete design with real visual inspection", async () => {
  const step = (await validateStepBatch(repoRoot, [37])).steps[0];
  const content = await readFile(join(repoRoot, step.target), "utf8");

  assert.equal(step.visual_review, true);
  assert.ok(step.acceptance.some((item) => (
    item.kind === "artifact" && item.required && item.path === "step_archive/screenshots/research/step022-primary-desktop.png"
  )));
  assert.ok(step.acceptance.some((item) => item.id === "visual-evidence-inspection" && item.required));
  assertStep37ImplementationContract(content);
});

test("step037 section checks reject missing topic fields, reselection, fake inspection, and missing manifest traceability", async () => {
  const original = await readFile(join(repoRoot, "codex", "assets", "steps", "step037.md"), "utf8");
  const mutations = {
    missingAudience: original.replace("`audience`", "`target_group`"),
    reselection: original.replace("다시 선택하지 않는다", "필요하면 선택을 변경한다"),
    fakeInspection: original.replace("실제로 열어", "파일명만 확인해"),
    missingDigest: original.replace("digest", "파일 크기"),
    noVisualBlock: original.replace("시각 검사 기능을 사용할 수 없으면", "시각 검사 기능을 사용할 수 없어도")
  };

  assertStep37ImplementationContract(original);
  for (const [name, mutation] of Object.entries(mutations)) {
    assert.notEqual(mutation, original, `step037 mutation did not change content: ${name}`);
    assert.throws(() => assertStep37ImplementationContract(mutation), undefined, `step037 mutation escaped: ${name}`);
  }
});

function assertStep38GateContract(content) {
  const section = extractMarkdownSection(content, "필수 빌드와 순환 의존성 게이트").replace(/\s+/g, " ");
  assert.match(section, /project manifest[^]*선언된[^]*build[^]*정확한 명령/);
  assert.match(section, /exit code 0[^]*실패[^]*차단/i);
  assert.match(section, /dist\/index\.html[^]*일반 파일[^]*0바이트보다 크[^]*<html[^]*<\/html>/i);
  assert.match(section, /순환 의존성이 0개인지 별도 필수 gate로 확인한다/);
  assert.match(section, /로컬[^]*(?:cycle|madge)[^]*결정적 정적 import graph fallback/i);
  assert.match(section, /두 필수 게이트[^]*`PASS`[^]*trust5_r1\.md/);
  assert.match(section, /lint[^]*format[^]*type[^]*경고[^]*필수 게이트를 대체하지 않는다/i);
  assert.doesNotMatch(content, /--if-present|\bnpx\b|html-bundler|step\s*0?81|스킵[^]*(?:빌드|순환)/i);
}

test("step038 is a non-skippable declared-build and zero-cycle PASS gate", async () => {
  const step = (await validateStepBatch(repoRoot, [38])).steps[0];
  const content = await readFile(join(repoRoot, step.target), "utf8");
  const commandItems = step.acceptance.filter((item) => item.kind === "command");

  assertStep38GateContract(content);
  assert.equal(commandItems.length, 1);
  assert.equal(commandItems[0].required, true);
  assert.match(commandItems[0].command_pattern, /^\^/);
  assert.match(commandItems[0].command_pattern, /\$$/);
  assert.doesNotThrow(() => new RegExp(commandItems[0].command_pattern));
  assert.equal(new RegExp(commandItems[0].command_pattern).test("npm run build"), true);
  assert.equal(new RegExp(commandItems[0].command_pattern).test("npm run test"), false);
  assert.equal(new RegExp(commandItems[0].command_pattern).test("npm run build --if-present"), false);
});

test("optional tooling command patterns are anchored, offline, and cannot accept implicit downloads", async () => {
  const steps = (await validateStepBatch(repoRoot, [33, 34])).steps;

  for (const step of steps) {
    const item = step.acceptance.find((acceptance) => acceptance.kind === "command");
    assert.equal(item.required, false);
    assert.match(item.command_pattern, /^\^/);
    assert.match(item.command_pattern, /\$$/);
    assert.match(item.command_pattern, /--offline/);
    assert.doesNotMatch(item.command_pattern, /\bnpx\b|--yes/);
    assert.doesNotThrow(() => new RegExp(item.command_pattern));
  }
});

test("step038 section checks reject optional builds, empty HTML, skipped cycles, stale bundlers, and premature milestones", async () => {
  const original = await readFile(join(repoRoot, "codex", "assets", "steps", "step038.md"), "utf8");
  const mutations = {
    optionalBuild: original.replace("정확한 명령", "--if-present를 붙인 명령"),
    emptyHtml: original.replace("0바이트보다 크고", "0바이트여도 되고"),
    skippedCycles: original.replace("순환 의존성이 0개", "순환 의존성은 스킵"),
    staleBundler: original.replace("## 완료 조건", "html-bundler.ps1을 실행한다.\n\n## 완료 조건"),
    prematureMilestone: original.replace("두 필수 게이트가 모두 `PASS`인 뒤에만", "빌드 전에도")
  };

  assertStep38GateContract(original);
  for (const [name, mutation] of Object.entries(mutations)) {
    assert.notEqual(mutation, original, `step038 mutation did not change content: ${name}`);
    assert.throws(() => assertStep38GateContract(mutation), undefined, `step038 mutation escaped: ${name}`);
  }
});

const REVIEW_BUILD_COMMAND_PATTERN = "^(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run) (?:build|[A-Za-z0-9][A-Za-z0-9:_-]*build[A-Za-z0-9:_-]*)$";

const EXPECTED_REVIEW_ACCEPTANCE_DESCRIPTIONS = {
  step039: {
    "layout-desktop-screenshot": "Stores the final 1920x1080 layout verification capture after any fixes.",
    "layout-tablet-screenshot": "Stores the final 768x1024 layout verification capture after any fixes.",
    "layout-mobile-screenshot": "Stores the final 390x844 layout verification capture after any fixes.",
    "layout-verification-report": "Stores every bounded independent layout review round and the final evidenced verdict.",
    "exact-layout-viewports": "Confirms captures use exactly the declared desktop, tablet, and mobile viewports.",
    "design-responsive-accessibility": "Confirms design fidelity, responsive behavior, and accessibility are all independently checked.",
    "independent-layout-verifier": "Confirms the non-modifying verifier is distinct from the layout remediator.",
    "visual-inspection-required": "Confirms the verifier actually opens every final screenshot and deterministic checks never replace visual inspection.",
    "bounded-pass-loop": "Requires an evidenced PASS within five rounds with no unresolved Critical or Important finding."
  },
  step040: {
    "comparison-desktop-screenshot": "Stores the final desktop implementation capture compared with persisted research.",
    "comparison-tablet-screenshot": "Stores the final tablet implementation capture compared with persisted research.",
    "comparison-mobile-screenshot": "Stores the final mobile implementation capture compared with persisted research.",
    "research-comparison-report": "Stores every bounded independent eight-axis comparison round and final verdict.",
    "persisted-research-only": "Confirms comparison uses only persisted Step 22 through 24 evidence and performs no new browsing.",
    "eight-axis-comparison": "Confirms all eight declared design axes are compared at every required viewport.",
    "comparison-traceability": "Traces every judgment and remediation to exact persisted evidence and observed screenshot regions.",
    "independent-comparison-verifier": "Confirms the non-modifying verifier is distinct from the comparison remediator.",
    "visual-inspection-required": "Confirms persisted and implementation screenshots are actually opened rather than inferred from files or checks.",
    "bounded-pass-loop": "Requires an evidenced PASS within five rounds with no unresolved Critical or Important finding."
  },
  step041: {
    "javascript-modularization-report": "Stores module boundaries, behavior checks, async lifecycle evidence, build results, and independent review.",
    "project-build-command": "Runs the exact non-optional build script declared by the project manifest.",
    "external-javascript-modules": "Confirms JavaScript lives in external src/js modules with no inline script implementation.",
    "class-boundaries": "Confirms cohesive Class boundaries and lightweight constructors preserve the selected architecture.",
    "async-lifecycle": "Confirms async initialization, start, I/O, concurrency, yielding, cancellation, and error handling.",
    "behavior-preservation": "Confirms behavior, accessibility, and the current dist HTML boundary remain intact after modularization.",
    "independent-javascript-verifier": "Confirms a non-modifying independent verifier checks source, behavior, build, and report evidence."
  },
  step042: {
    "css-separation-report": "Stores CSS responsibility boundaries, reference order, responsive and accessibility checks, build results, and independent review.",
    "project-build-command": "Runs the exact non-optional build script declared by the project manifest.",
    "external-css-files": "Confirms styles live in responsibility-based src/css files with no style element or style attribute.",
    "stylesheet-order-and-references": "Confirms stylesheet order, tokens, breakpoints, and HTML references remain correct.",
    "css-accessibility-preserved": "Confirms focus, reduced motion, contrast, and responsive behavior remain intact.",
    "independent-css-verifier": "Confirms a non-modifying independent verifier checks CSS boundaries, behavior, build, and report evidence."
  },
  step043: {
    "awwwards-applied-screenshot": "Stores the final implementation capture after evidence-bound Awwwards remediation.",
    "awwwards-verification-report": "Stores every bounded independent Awwwards comparison round and the final evidenced verdict.",
    "persisted-research-only": "Confirms review uses only persisted Step 22 through 24 research and performs no new browsing.",
    "minimal-evidence-bound-remediation": "Confirms changes are minimal and trace only to observed evidence, using CSS before necessary visualization JavaScript or HTML.",
    "independent-awwwards-verifier": "Confirms the non-modifying verifier is distinct from the Awwwards remediator.",
    "visual-inspection-required": "Confirms the verifier actually opens the research and implementation screenshots.",
    "bounded-pass-loop": "Requires an evidenced PASS within five rounds with no unresolved Critical or Important finding."
  },
  step044: {
    "routing-integration-report": "Stores routing integration, semantic structure, source reference integrity, accessibility, current build evidence, and independent review.",
    "review-milestone": "Stores the second quality milestone only after routing, build, structure, and accessibility gates pass.",
    "project-build-command": "Runs the exact non-optional build script declared by the project manifest.",
    "external-assets-only": "Confirms development JavaScript and CSS remain external while the build bundles them into one self-contained HTML with its inert route manifest.",
    "accessibility-reference-integrity": "Confirms landmarks, labels, keyboard and focus behavior, and every asset reference remain intact.",
    "dist-html-boundary": "Confirms the current build produces a regular nonempty dist/index.html with valid HTML boundaries.",
    "independent-milestone-verifier": "Confirms a non-modifying independent verifier checks routing integration, build, structure, accessibility, and evidence.",
    "pass-only-quality-milestone": "Requires all mandatory checks to PASS before the second milestone is created.",
    "routing-screen-url-map": "Confirms the canonical route manifest, screen roots, visible screen, title, active navigation, and focus agree after source modularization.",
    "routing-deep-link-traversal": "Confirms direct entry, reload, initial restoration and unknown-route replacement for every route; real outgoing links and Back/Forward are required for multiple screens, or recorded not-applicable: single-screen.",
    "routing-navigation-backends": "Confirms one capable Navigation API backend or the declared History/hash fallback, including unavailable and partial-capability environments without changing URL mode.",
    "routing-server-fallback": "Confirms mode-specific fallback configuration and local direct entry; hash/file records why rewrites are unnecessary, while actual deployment verification remains in Step 45.",
    "routing-native-behavior": "Confirms document anchors, forms, modified clicks, new tabs, downloads, and external links retain native behavior without duplicate rendering or history entries.",
    "measured-quality-report": "Runtime-populated current measured-quality PASS with validated immutable report digest; required for every new completion."
  }
};

function assertReviewAcceptanceDescriptions(steps) {
  const actual = Object.fromEntries(steps.map((step) => [
    step.id,
    Object.fromEntries(step.acceptance.map((item) => [item.id, item.description]))
  ]));
  assert.deepEqual(actual, EXPECTED_REVIEW_ACCEPTANCE_DESCRIPTIONS);
}

const REVIEW_ROLE_CONTRACTS = [
  { number: 39, worker: /레이아웃 보정자 역할/, verifier: /레이아웃 독립 검증자 역할/ },
  { number: 40, worker: /디자인 비교 보정자 역할/, verifier: /디자인 비교 독립 검증자 역할/ },
  { number: 41, worker: /JavaScript 모듈 구현자 역할/, verifier: /JavaScript 독립 검증자 역할/ },
  { number: 42, worker: /CSS 분리 구현자 역할/, verifier: /CSS 독립 검증자 역할/ },
  { number: 43, worker: /Awwwards 보정 구현자 역할/, verifier: /Awwwards 독립 검증자 역할/ },
  { number: 44, worker: /라우팅 통합 구현자 역할/, verifier: /milestone 독립 검증자 역할/ }
];

function assertReviewRoleContract(content, { worker, verifier }) {
  const roleSection = extractMarkdownSection(content, "실행 역할").replace(/\s+/g, " ");
  assert.match(roleSection, worker);
  assert.match(roleSection, verifier);
  assert.match(roleSection, /독립 검증자[^]*산출물과 application source를 수정하지 않는다/);
  assert.match(roleSection, /위임 기능을 사용할 수 없으면[^]*현재 실행자가[^]*두 역할을 명확히 분리[^]*순서대로 수행/);
  assert.match(roleSection, /별도 역할을 위임했다고 기록하지 않는다/);
  assertPlanningPermissionContract(content);
}

const EXPECTED_REVIEW_TARGET_SHA256 = Object.freeze({
  step039: "4fea345e2b9099c224fb976aba8c67a77b64812bf66c51dd255994abb2875f77",
  step040: "54ac1baac5086ce382de0147f66f568deebc30a997aa26471cf42a659b8669e0",
  step041: "c7062942a31f2ce520dfdcad0634082be2a21500ead63cc402fda1be6240e19d",
  step042: "a94fcec2f5371b57985e37587356aa00a866af34adaaf0c7cd9832812ad74ca0",
  step043: "96d6c4085abc4fba0ad0a8a9914cd320731ab503c91890b9630acea41a922a1f",
  step044: "3c16321a6741e5efa04d10aa9173ba50a19eb625f13c5abd47a12491bc2f8023"
});

async function assertReviewTargetDigests(root) {
  for (const [id, expected] of Object.entries(EXPECTED_REVIEW_TARGET_SHA256)) {
    const relativePath = "codex/assets/steps/" + id + ".md";
    let bytes;
    try {
      bytes = await readFile(join(root, relativePath));
    } catch (error) {
      const actual = "unreadable:" + (error?.code ?? "unknown");
      throw new Error(id + " target digest mismatch: path=" + relativePath + " expected=" + expected + " actual=" + actual);
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      throw new Error(id + " target digest mismatch: path=" + relativePath + " expected=" + expected + " actual=" + actual);
    }
  }
}

function projectReviewStep(step) {
  return {
    number: step.number,
    id: step.id,
    title: step.title,
    phase: step.phase,
    source: step.source,
    target: step.target,
    source_sha256: step.source_sha256,
    inputs: step.inputs,
    outputs: step.outputs,
    requires: step.requires,
    optional_requires: step.optional_requires,
    network: step.network,
    visual_review: step.visual_review,
    acceptance: step.acceptance.map((item) => ({
      id: item.id,
      kind: item.kind,
      required: item.required,
      ...(item.path === undefined ? {} : { path: item.path }),
      ...(item.command_pattern === undefined ? {} : { command_pattern: item.command_pattern })
    })),
    ported: step.ported,
    next: step.next
  };
}

const EXPECTED_REVIEW_ROWS = [
  {
    number: 39,
    id: "step039",
    title: "레이아웃 스크린샷 검증 (독립 검증 루프)",
    phase: "review",
    source: "assets/steps/step039.md",
    target: "codex/assets/steps/step039.md",
    source_sha256: "3bb496a9dd3a525272e56eaabe99a9dc4c21735f14f9ffbcc7227db5852348c4",
    inputs: [
      "step_archive/step030_레이아웃설계_chunk1.md",
      "step_archive/step030_전체설계_chunk1.md",
      "step_archive/step037_구현manifest.md",
      "step_archive/step038_smoke_test.md",
      "step_archive/outputs/trust5_r1.md",
      "dist/index.html"
    ],
    outputs: [
      "step_archive/screenshots/layout-verify-desktop-r1.png",
      "step_archive/screenshots/layout-verify-tablet-r1.png",
      "step_archive/screenshots/layout-verify-mobile-r1.png",
      "step_archive/outputs/step039_검증_r1.md"
    ],
    requires: ["step030", "step037", "step038"],
    optional_requires: [],
    network: false,
    visual_review: true,
    acceptance: [
      { id: "layout-desktop-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/layout-verify-desktop-r1.png" },
      { id: "layout-tablet-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/layout-verify-tablet-r1.png" },
      { id: "layout-mobile-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/layout-verify-mobile-r1.png" },
      { id: "layout-verification-report", kind: "artifact", required: true, path: "step_archive/outputs/step039_검증_r1.md" },
      { id: "exact-layout-viewports", kind: "check", required: true },
      { id: "design-responsive-accessibility", kind: "check", required: true },
      { id: "independent-layout-verifier", kind: "check", required: true },
      { id: "visual-inspection-required", kind: "check", required: true },
      { id: "bounded-pass-loop", kind: "check", required: true }
    ],
    ported: true,
    next: "step040"
  },
  {
    number: 40,
    id: "step040",
    title: "조사 스크린샷 vs 구현 스크린샷 비교 검증 (독립 검증 루프)",
    phase: "review",
    source: "assets/steps/step040.md",
    target: "codex/assets/steps/step040.md",
    source_sha256: "ba1801ce1f1c530fc1fba503d5fb4b08f4711452ccf68ae96384245d5f7036f7",
    inputs: [
      "step_archive/step022_수집결과_chunk1.md",
      "step_archive/awwwards-step022-primary.txt",
      "step_archive/screenshots/research/step022-primary-desktop.png",
      "step_archive/step023_조사결과_chunk1.md",
      "step_archive/outputs/step024_검증_r1.md",
      "step_archive/step030_레이아웃설계_chunk1.md",
      "step_archive/screenshots/layout-verify-desktop-r1.png",
      "step_archive/screenshots/layout-verify-tablet-r1.png",
      "step_archive/screenshots/layout-verify-mobile-r1.png",
      "step_archive/outputs/step039_검증_r1.md"
    ],
    outputs: [
      "step_archive/screenshots/compare-impl-desktop.png",
      "step_archive/screenshots/compare-impl-tablet.png",
      "step_archive/screenshots/compare-impl-mobile.png",
      "step_archive/outputs/step040_검증.md"
    ],
    requires: ["step022", "step023", "step024", "step030", "step039"],
    optional_requires: [],
    network: false,
    visual_review: true,
    acceptance: [
      { id: "comparison-desktop-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/compare-impl-desktop.png" },
      { id: "comparison-tablet-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/compare-impl-tablet.png" },
      { id: "comparison-mobile-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/compare-impl-mobile.png" },
      { id: "research-comparison-report", kind: "artifact", required: true, path: "step_archive/outputs/step040_검증.md" },
      { id: "persisted-research-only", kind: "check", required: true },
      { id: "eight-axis-comparison", kind: "check", required: true },
      { id: "comparison-traceability", kind: "check", required: true },
      { id: "independent-comparison-verifier", kind: "check", required: true },
      { id: "visual-inspection-required", kind: "check", required: true },
      { id: "bounded-pass-loop", kind: "check", required: true }
    ],
    ported: true,
    next: "step041"
  },
  {
    number: 41,
    id: "step041",
    title: "JavaScript 모듈화",
    phase: "review",
    source: "assets/steps/step041.md",
    target: "codex/assets/steps/step041.md",
    source_sha256: "8c203e922eda2b5a043bf7ab2e878d07b7d4248169fcd53f84db31acef863c4a",
    inputs: [
      "step_archive/step030_전체설계_chunk1.md",
      "step_archive/step037_구현manifest.md",
      "step_archive/step038_smoke_test.md",
      "dist/index.html",
      "step_archive/outputs/step040_검증.md"
    ],
    outputs: ["step_archive/step041_js모듈화.md"],
    requires: ["step030", "step037", "step038", "step040"],
    optional_requires: [],
    network: false,
    visual_review: false,
    acceptance: [
      { id: "javascript-modularization-report", kind: "artifact", required: true, path: "step_archive/step041_js모듈화.md" },
      { id: "project-build-command", kind: "command", required: true, command_pattern: REVIEW_BUILD_COMMAND_PATTERN },
      { id: "external-javascript-modules", kind: "check", required: true },
      { id: "class-boundaries", kind: "check", required: true },
      { id: "async-lifecycle", kind: "check", required: true },
      { id: "behavior-preservation", kind: "check", required: true },
      { id: "independent-javascript-verifier", kind: "check", required: true }
    ],
    ported: true,
    next: "step042"
  },
  {
    number: 42,
    id: "step042",
    title: "CSS 파일 분리 (컨텍스트 최적화)",
    phase: "review",
    source: "assets/steps/step042.md",
    target: "codex/assets/steps/step042.md",
    source_sha256: "fff6c60ac51bf80144528ba17454efbd5938f34b26c32a95d813c8039f72b1c0",
    inputs: [
      "step_archive/step030_레이아웃설계_chunk1.md",
      "step_archive/step030_전체설계_chunk1.md",
      "step_archive/step037_구현manifest.md",
      "step_archive/step041_js모듈화.md"
    ],
    outputs: ["step_archive/step042_css분리.md"],
    requires: ["step030", "step037", "step041"],
    optional_requires: [],
    network: false,
    visual_review: false,
    acceptance: [
      { id: "css-separation-report", kind: "artifact", required: true, path: "step_archive/step042_css분리.md" },
      { id: "project-build-command", kind: "command", required: true, command_pattern: REVIEW_BUILD_COMMAND_PATTERN },
      { id: "external-css-files", kind: "check", required: true },
      { id: "stylesheet-order-and-references", kind: "check", required: true },
      { id: "css-accessibility-preserved", kind: "check", required: true },
      { id: "independent-css-verifier", kind: "check", required: true }
    ],
    ported: true,
    next: "step043"
  },
  {
    number: 43,
    id: "step043",
    title: "Awwwards 디자인 검증 및 CSS 보강 (독립 검증 루프)",
    phase: "review",
    source: "assets/steps/step043.md",
    target: "codex/assets/steps/step043.md",
    source_sha256: "d232ead02f2fcfcc01e32432f6d318f4a128e981297848027a66ac9a98a2aad8",
    inputs: [
      "step_archive/step022_수집결과_chunk1.md",
      "step_archive/awwwards-step022-primary.txt",
      "step_archive/screenshots/research/step022-primary-desktop.png",
      "step_archive/step023_조사결과_chunk1.md",
      "step_archive/outputs/step024_검증_r1.md",
      "step_archive/step030_레이아웃설계_chunk1.md",
      "step_archive/screenshots/compare-impl-desktop.png",
      "step_archive/screenshots/compare-impl-tablet.png",
      "step_archive/screenshots/compare-impl-mobile.png",
      "step_archive/outputs/step040_검증.md",
      "step_archive/step042_css분리.md"
    ],
    outputs: [
      "step_archive/screenshots/compare-awwwards-applied-r1.png",
      "step_archive/outputs/step043_검증_r1.md"
    ],
    requires: ["step022", "step023", "step024", "step030", "step040", "step042"],
    optional_requires: [],
    network: false,
    visual_review: true,
    acceptance: [
      { id: "awwwards-applied-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/compare-awwwards-applied-r1.png" },
      { id: "awwwards-verification-report", kind: "artifact", required: true, path: "step_archive/outputs/step043_검증_r1.md" },
      { id: "persisted-research-only", kind: "check", required: true },
      { id: "minimal-evidence-bound-remediation", kind: "check", required: true },
      { id: "independent-awwwards-verifier", kind: "check", required: true },
      { id: "visual-inspection-required", kind: "check", required: true },
      { id: "bounded-pass-loop", kind: "check", required: true }
    ],
    ported: true,
    next: "step044"
  },
  {
    number: 44,
    id: "step044",
    title: "클라이언트 사이드 라우팅",
    phase: "review",
    source: "assets/steps/step044.md",
    target: "codex/assets/steps/step044.md",
    source_sha256: "d238b47246569421402b3eebf755345943fb3e74a1ef285506c0cba97541325d",
    inputs: [
      "step_archive/step030_레이아웃설계_chunk1.md",
      "step_archive/step030_전체설계_chunk1.md",
      "step_archive/step038_smoke_test.md",
      "step_archive/outputs/trust5_r1.md",
      "dist/index.html",
      "step_archive/step041_js모듈화.md",
      "step_archive/step042_css분리.md",
      "step_archive/screenshots/compare-awwwards-applied-r1.png",
      "step_archive/outputs/step043_검증_r1.md"
    ],
    outputs: [
      "step_archive/step044_routing검증.md",
      "step_archive/outputs/trust5_r2.md"
    ],
    requires: ["step030", "step038", "step041", "step042", "step043"],
    optional_requires: [],
    network: false,
    visual_review: false,
    acceptance: [
      { id: "routing-integration-report", kind: "artifact", required: true, path: "step_archive/step044_routing검증.md" },
      { id: "review-milestone", kind: "artifact", required: true, path: "step_archive/outputs/trust5_r2.md" },
      { id: "project-build-command", kind: "command", required: true, command_pattern: REVIEW_BUILD_COMMAND_PATTERN },
      { id: "external-assets-only", kind: "check", required: true },
      { id: "accessibility-reference-integrity", kind: "check", required: true },
      { id: "dist-html-boundary", kind: "check", required: true },
      { id: "independent-milestone-verifier", kind: "check", required: true },
      { id: "pass-only-quality-milestone", kind: "check", required: true },
      { id: "routing-screen-url-map", kind: "check", required: true },
      { id: "routing-deep-link-traversal", kind: "check", required: true },
      { id: "routing-navigation-backends", kind: "check", required: true },
      { id: "routing-server-fallback", kind: "check", required: true },
      { id: "routing-native-behavior", kind: "check", required: true },
      { id: "measured-quality-report", kind: "check", required: false }
    ],
    ported: true,
    next: "step045"
  }
];

test("review batch declares exact metadata, evidence contracts, descriptions, and visual set", async () => {
  await assertReviewTargetDigests(repoRoot);
  const report = await validateStepBatch(repoRoot, [39, 40, 41, 42, 43, 44]);
  assertReviewAcceptanceDescriptions(report.steps);
  assert.deepEqual(report.steps.map(projectReviewStep), EXPECTED_REVIEW_ROWS);
  assert.deepEqual(
    report.steps.filter((step) => step.visual_review).map((step) => step.number),
    [39, 40, 43]
  );
});

test("review source hashes bind reviewed source steps 039 through 044", async () => {
  const index = await loadIndex(repoRoot);
  const hashes = await recordSourceHashes(repoRoot, index.steps.slice(38, 44));

  assert.deepEqual(hashes, {
    step039: "3bb496a9dd3a525272e56eaabe99a9dc4c21735f14f9ffbcc7227db5852348c4",
    step040: "ba1801ce1f1c530fc1fba503d5fb4b08f4711452ccf68ae96384245d5f7036f7",
    step041: "8c203e922eda2b5a043bf7ab2e878d07b7d4248169fcd53f84db31acef863c4a",
    step042: "fff6c60ac51bf80144528ba17454efbd5938f34b26c32a95d813c8039f72b1c0",
    step043: "d232ead02f2fcfcc01e32432f6d318f4a128e981297848027a66ac9a98a2aad8",
    step044: "d238b47246569421402b3eebf755345943fb3e74a1ef285506c0cba97541325d"
  });
});

test("review acceptance descriptions reject placeholder-wide mutation", async () => {
  const index = await loadIndex(repoRoot);
  const mutated = structuredClone(index.steps.slice(38, 44));
  for (const step of mutated) {
    for (const item of step.acceptance ?? []) item.description = "x";
  }
  assert.throws(() => assertReviewAcceptanceDescriptions(mutated));
});

test("review documents bind exact frontmatter titles and only their current Step heading", async () => {
  const expected = EXPECTED_REVIEW_ROWS.map((row) => ({
    name: row.id,
    number: row.number,
    title: row.title
  }));

  for (const item of expected) {
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", item.name + ".md"), "utf8");
    assert.deepEqual(parseStepDocument(content), {
      frontmatter: { name: item.name, phase: "review" },
      titles: [{ number: item.number, title: item.title }],
      referencedSteps: [item.number]
    });
  }
});

test("review outputs are uniquely owned required artifacts with closed direct dependencies", async () => {
  const index = await loadIndex(repoRoot);
  const review = (await validateStepBatch(repoRoot, [39, 40, 41, 42, 43, 44])).steps;
  const ownersByOutput = new Map();
  for (const step of index.steps) {
    for (const output of step.outputs ?? []) {
      const owners = ownersByOutput.get(output) ?? [];
      owners.push(step.id);
      ownersByOutput.set(output, owners);
    }
  }
  const ownerByOutput = new Map(
    [...ownersByOutput].map(([output, owners]) => [output, owners.length === 1 ? owners[0] : null])
  );
  const allOutputs = review.flatMap((step) => step.outputs);

  assert.equal(new Set(allOutputs).size, allOutputs.length);
  assert.deepEqual(ownersByOutput.get("dist/index.html"), ["step038"]);
  assert.ok(index.steps[37].outputs.includes("dist/index.html"), "Step 38 must declare its required dist artifact as an output");
  for (const step of review) {
    for (const output of step.outputs) {
      assert.deepEqual(ownersByOutput.get(output), [step.id], output + " must have exactly one canonical owner");
      assert.ok(step.acceptance.some((item) => (
        item.kind === "artifact" && item.required && item.path === output
      )), step.id + " output lacks required artifact evidence: " + output);
    }
    for (const input of step.inputs) {
      const owner = ownerByOutput.get(input);
      if (owner) assert.ok(step.requires.includes(owner), step.id + " does not require the owner of " + input);
    }
    for (const dependency of step.requires) {
      assert.ok(
        step.inputs.some((input) => ownerByOutput.get(input) === dependency),
        step.id + " has an unbound dependency " + dependency
      );
    }
  }
});

test("review instructions stay provider-neutral, permission-preserving, receipt-owned, and current-step scoped", async () => {
  const review = (await validateStepBatch(repoRoot, [39, 40, 41, 42, 43, 44])).steps;

  for (const step of review) {
    const content = await readFile(join(repoRoot, step.target), "utf8");
    assert.deepEqual(scanForbiddenTokens(content), []);
    assert.doesNotMatch(content, /(?:progress|state)\.json|\.harness50-codex|transcript/i);
    assert.doesNotMatch(content, /\/(?:webapp|harness-status|harness-reset)\b|\$(?:webapp|harness(?:14|20|36|50)-(?:status|reset))\b/i);
    assert.doesNotMatch(content, /\b(?:SessionStart|UserPromptSubmit|PreToolUse|Stop)\b|\bhooks?\b/i);
    assert.doesNotMatch(content, /(?:다음|후속)\s*(?:Step|단계)|\bnext\s+step\b/i);
    assert.doesNotMatch(content, /\b(?:npx|html-bundler)\b|step\s*0?81|--if-present/i);
    assertReviewRoleContract(content, REVIEW_ROLE_CONTRACTS.find((item) => item.number === step.number));
    const normalized = content.replace(/\s+/g, " ");
    assert.match(normalized, /수락 증거[^]*현재 단계에서 멈춘다/);
    assert.match(normalized, /workflow 상태와 영수증[^]*진행을 소유/);
  }
});

test("review roles reject per-step removals, false delegation, and permission contradictions", async () => {
  for (const contract of REVIEW_ROLE_CONTRACTS) {
    const id = "step" + String(contract.number).padStart(3, "0");
    const original = await readFile(join(repoRoot, "codex", "assets", "steps", id + ".md"), "utf8");
    const mutations = {
      workerRemoved: original.replace(contract.worker, "삭제된 실행 역할"),
      verifierRemoved: original.replace(contract.verifier, "삭제된 검증 역할"),
      fallbackRemoved: original.replace(/위임 기능을 사용할 수 없으면[^.]+\./, "위임할 수 없으면 검증 없이 완료한다."),
      falseDelegation: original.replace(/별도 역할을 위임했다고\s*기록하지\s*않는다/, "별도 역할을 위임했다고 기록한다"),
      autoApproval: original.replace("## 입력과 산출물", "안전 명령은 자동 승인한다.\n\n## 입력과 산출물"),
      permissionBypass: original.replace("## 입력과 산출물", "권한 확인 절차를 우회한다.\n\n## 입력과 산출물")
    };

    for (const [name, mutation] of Object.entries(mutations)) {
      assert.notEqual(mutation, original, id + " mutation did not change content: " + name);
      assert.throws(
        () => assertReviewRoleContract(mutation, contract),
        undefined,
        id + " role mutation escaped: " + name
      );
    }
  }
});

test("review build command contracts exactly match the current Step 38 gate", async () => {
  const steps = (await validateStepBatch(repoRoot, [38, 41, 42, 44])).steps;
  const patterns = steps.map((step) => {
    const commands = step.acceptance.filter((item) => item.kind === "command");
    assert.equal(commands.length, 1);
    assert.equal(commands[0].required, true);
    assert.match(commands[0].command_pattern, /^\^/);
    assert.match(commands[0].command_pattern, /\$$/);
    assert.doesNotThrow(() => new RegExp(commands[0].command_pattern));
    return commands[0].command_pattern;
  });
  assert.deepEqual(patterns, [
    REVIEW_BUILD_COMMAND_PATTERN,
    REVIEW_BUILD_COMMAND_PATTERN,
    REVIEW_BUILD_COMMAND_PATTERN,
    REVIEW_BUILD_COMMAND_PATTERN
  ]);
  const matcher = new RegExp(REVIEW_BUILD_COMMAND_PATTERN);
  assert.equal(matcher.test("npm run build"), true);
  assert.equal(matcher.test("pnpm run app:build"), true);
  assert.equal(matcher.test("npm run test"), false);
  assert.equal(matcher.test("npm run build --if-present"), false);
});

test("review target digest seal rejects unsafe and benign byte mutations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness50-review-digests-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "codex", "assets", "steps"), { recursive: true });
  const cases = [
    [39, "Visual inspection may be skipped and the step still passes."],
    [40, "New browsing may replace persisted research evidence."],
    [41, "Inline scripts and unhandled promises are acceptable."],
    [42, "Inline style elements and attributes are acceptable."],
    [43, "An unresolved Important finding may still pass."],
    [44, "Create the milestone before build and accessibility checks."]
  ];
  const originals = new Map();

  for (const [number] of cases) {
    const id = "step" + String(number).padStart(3, "0");
    const relativePath = "codex/assets/steps/" + id + ".md";
    const bytes = await readFile(join(repoRoot, relativePath));
    originals.set(id, bytes);
    await writeFile(join(root, relativePath), bytes);
  }

  const escaped = [];
  const wrongDiagnostics = [];
  for (const [number, contradiction] of cases) {
    const id = "step" + String(number).padStart(3, "0");
    const relativePath = "codex/assets/steps/" + id + ".md";
    const original = originals.get(id);
    const mutations = [
      ["unsafe-contradiction", Buffer.concat([original, Buffer.from("\n" + contradiction + "\n")])],
      ["benign-whitespace", Buffer.concat([original, Buffer.from("\n")])]
    ];
    for (const [name, mutated] of mutations) {
      await writeFile(join(root, relativePath), mutated);
      const actual = createHash("sha256").update(mutated).digest("hex");
      const expectedMessage = id + " target digest mismatch: path=" + relativePath
        + " expected=" + EXPECTED_REVIEW_TARGET_SHA256[id] + " actual=" + actual;
      try {
        await assertReviewTargetDigests(root);
        escaped.push(id + ":" + name);
      } catch (error) {
        if (error.message !== expectedMessage) wrongDiagnostics.push(id + ":" + name + ":" + error.message);
      } finally {
        await writeFile(join(root, relativePath), original);
      }
    }
  }
  assert.deepEqual({ escaped, wrongDiagnostics }, { escaped: [], wrongDiagnostics: [] });
});

function assertBoundedVisualLoop(section) {
  const normalized = section.replace(/\s+/g, " ");
  assert.match(normalized, /최대 5라운드/);
  assert.match(normalized, /`Critical`[^]*`Important`[^]*하나라도 미해결[^]*차단/);
  assert.match(normalized, /시각 검사 기능[^]*사용할 수 없으면[^]*차단/);
  assert.match(normalized, /결정적 DOM[^]*layout[^]*접근성[^]*실제로 이미지를 여는 시각 검사를 대체하지 못한다/i);
  assert.match(normalized, /실제로 열어/);
  assert.match(normalized, /`PASS`[^]*경우에만/);
  assert.doesNotMatch(normalized, /스킵[^.]{0,80}(?:통과|완료)|미해결[^.]{0,80}(?:통과|완료)/);
}

function assertStep39Contract(content) {
  const sections = extractOrderedMarkdownSections(content, [
    "목표",
    "입력과 산출물",
    "실행 역할",
    "촬영과 독립 검증 루프",
    "완료 조건"
  ]);
  const loop = sections["촬영과 독립 검증 루프"].replace(/\s+/g, " ");
  for (const required of [
    /1920[×x]1080[^]*layout-verify-desktop-r1\.png/,
    /768[×x]1024[^]*layout-verify-tablet-r1\.png/,
    /390[×x]844[^]*layout-verify-mobile-r1\.png/,
    /보정[^]*세 뷰포트 모두 다시 촬영/,
    /최종 스크린샷[^]*모두 실제로 열어/,
    /레이아웃 설계[^]*전체 설계[^]*design fidelity[^]*responsive[^]*accessibility/i
  ]) assert.match(loop, required);
  assertBoundedVisualLoop(sections["촬영과 독립 검증 루프"]);
}

function assertStep40Contract(content) {
  const sections = extractOrderedMarkdownSections(content, [
    "목표",
    "입력과 산출물",
    "실행 역할",
    "지속된 조사 증거 비교",
    "완료 조건"
  ]);
  const comparison = sections["지속된 조사 증거 비교"].replace(/\s+/g, " ");
  assert.match(comparison, /22~24단계[^]*persisted[^]*새로운 browsing[^]*수행하지 않는다/i);
  assert.match(comparison, /desktop[^]*tablet[^]*mobile/i);
  for (const axis of [
    "레이아웃 구조",
    "시각적 계층",
    "여백/간격",
    "색상/대비",
    "컴포넌트 완성도",
    "컨트롤 패널 배치",
    "시각화 영역 비율",
    "반응형 전환"
  ]) assert.match(comparison, new RegExp(axis.replace("/", "\\/")));
  assert.match(comparison, /판정[^]*정확한 persisted evidence[^]*관찰한 screenshot 영역/i);
  assert.match(comparison, /연구 screenshot[^]*구현 screenshot[^]*실제로 열어/i);
  assertBoundedVisualLoop(sections["지속된 조사 증거 비교"]);
}

function assertStep41Contract(content) {
  const sections = extractOrderedMarkdownSections(content, [
    "목표",
    "입력과 산출물",
    "실행 역할",
    "JavaScript 모듈 경계",
    "비동기 lifecycle",
    "빌드와 독립 검증",
    "완료 조건"
  ]);
  const modules = sections["JavaScript 모듈 경계"].replace(/\s+/g, " ");
  const lifecycle = sections["비동기 lifecycle"].replace(/\s+/g, " ");
  const build = sections["빌드와 독립 검증"].replace(/\s+/g, " ");
  assert.match(modules, /src\/js\/\*\.js[^]*외부 module/i);
  assert.match(modules, /inline script[^]*금지/i);
  assert.match(modules, /Class[^]*책임[^]*constructor[^]*가벼운 동기 field/i);
  assert.match(lifecycle, /async init\(\)[^]*async start\(\)/i);
  assert.match(lifecycle, /I\/O[^]*async/i);
  assert.match(lifecycle, /Web Worker[^]*yield/i);
  assert.match(lifecycle, /Promise\.all/);
  assert.match(lifecycle, /cancel[^]*error[^]*unhandled/i);
  assert.match(lifecycle, /unhandled rejection[^]*남기지 않는다/i);
  assert.doesNotMatch(lifecycle, /unhandled rejection[^.]{0,80}(?:허용|괜찮|무시)/i);
  assert.match(build, /기존 behavior[^]*접근성[^]*보존/i);
  assert.match(build, /project manifest[^]*정확한 build 명령[^]*exit code 0/i);
  assert.match(build, /dist\/index\.html[^]*HTML boundary/i);
}

function assertStep42Contract(content) {
  const sections = extractOrderedMarkdownSections(content, [
    "목표",
    "입력과 산출물",
    "실행 역할",
    "CSS 책임 분리",
    "보존 검증",
    "빌드와 독립 검증",
    "완료 조건"
  ]);
  const separation = sections["CSS 책임 분리"].replace(/\s+/g, " ");
  const preservation = sections["보존 검증"].replace(/\s+/g, " ");
  const build = sections["빌드와 독립 검증"].replace(/\s+/g, " ");
  assert.match(separation, /src\/css\/\*\.css[^]*책임별/);
  assert.match(separation, /style attribute[^]*<style>[^]*금지/i);
  assert.match(separation, /stylesheet[^]*순서[^]*token[^]*breakpoint/i);
  assert.match(preservation, /HTML reference[^]*깨지지 않/i);
  assert.match(preservation, /focus[^]*reduced motion[^]*contrast[^]*responsive/i);
  assert.match(build, /project manifest[^]*정확한 build 명령[^]*exit code 0/i);
}

function assertStep43Contract(content) {
  const sections = extractOrderedMarkdownSections(content, [
    "목표",
    "입력과 산출물",
    "실행 역할",
    "증거 제한 보강 루프",
    "완료 조건"
  ]);
  const loop = sections["증거 제한 보강 루프"].replace(/\s+/g, " ");
  assert.match(loop, /22~24단계[^]*persisted[^]*새로운 browsing[^]*수행하지 않는다/i);
  assert.match(loop, /compare-awwwards-applied-r1\.png/);
  assert.match(loop, /최소 변경[^]*CSS[^]*necessary visualization JavaScript[^]*HTML/i);
  assert.match(loop, /정확한 persisted evidence[^]*관찰한 screenshot 영역/i);
  assert.match(loop, /연구 screenshot[^]*구현 screenshot[^]*실제로 열어/i);
  assertBoundedVisualLoop(sections["증거 제한 보강 루프"]);
  assertStep43RemediationOrder(content);
  const exclusion = extractMarkdownSection(content, "설계 제외 계약 우선").replace(/\s+/g, " ");
  assert.match(exclusion, /`step_archive\/step030_레이아웃설계_chunk1\.md`[^]*`harness50-design-contract`/);
  assert.match(exclusion, /`adopted`가 false[^]*누락 finding으로 판정하지 않는다[^]*목록 우선/);
  assert.match(exclusion, /`excluded-by-contract`[^]*보정 구현자는 그 스타일을 들여오지 않는다/);
  assert.match(exclusion, /계약 블록이 없으면[^]*30단계 산출물은 고치지 않는다/);
}

function assertStep43RemediationOrder(content) {
  const loop = extractMarkdownSection(content, "증거 제한 보강 루프").replace(/\s+/g, " ");
  assert.doesNotMatch(
    loop,
    /CSS만으로[^.]{0,160}고칠 수 있을 때에만[^.]{0,160}(?:necessary visualization\s+)?JavaScript/i
  );
  assert.doesNotMatch(
    loop,
    /(?:necessary visualization\s+)?JavaScript[^.]{0,120}only when CSS alone can (?:fix|resolve)/i
  );
  assert.match(loop, /CSS를 먼저 사용한다/);
  assert.match(
    loop,
    /CSS만으로 문제를 고칠 수 없고[^.]*data-rendering 책임에 속할 때에만[^.]*necessary visualization JavaScript를 변경한다/i
  );
  assert.match(
    loop,
    /semantic HTML은[^.]*CSS와 필요한 JavaScript만으로[^.]*적절히 해소할 수 없을 때[^.]*마지막으로 변경한다/i
  );
}

function assertStep44Contract(content) {
  const sections = extractOrderedMarkdownSections(content, [
    "목표",
    "입력과 산출물",
    "실행 역할",
    "routing 통합과 회귀 범위",
    "개발 source와 최종 HTML 경계",
    "구조와 접근성 검증",
    "현재 build 검증",
    "독립 milestone 검증",
    "완료 조건"
  ]);
  const sourceBoundary = sections["개발 source와 최종 HTML 경계"].replace(/\s+/g, " ");
  const structure = sections["구조와 접근성 검증"].replace(/\s+/g, " ");
  const build = sections["현재 build 검증"].replace(/\s+/g, " ");
  const milestone = sections["독립 milestone 검증"].replace(/\s+/g, " ");
  assert.match(sourceBoundary, /external JavaScript[^]*external CSS[^]*inline script[^]*style element[^]*style attribute/i);
  assert.match(structure, /landmark[^]*label[^]*keyboard[^]*focus[^]*asset reference/i);
  assert.match(build, /project manifest[^]*정확한 build 명령[^]*exit code 0/i);
  assert.match(build, /dist\/index\.html[^]*일반 파일[^]*0바이트보다 크[^]*<html[^]*<\/html>/i);
  assert.match(milestone, /build[^]*structure[^]*accessibility[^]*모두 `PASS`[^]*trust5_r2\.md/);
  assert.match(milestone, /독립 검증자[^]*수정하지 않/);
}

test("steps039, 040, and 043 require real bounded visual review rather than deterministic substitutes", async () => {
  const step39 = await readFile(join(repoRoot, "codex", "assets", "steps", "step039.md"), "utf8");
  const step40 = await readFile(join(repoRoot, "codex", "assets", "steps", "step040.md"), "utf8");
  const step43 = await readFile(join(repoRoot, "codex", "assets", "steps", "step043.md"), "utf8");
  assertStep39Contract(step39);
  assertStep40Contract(step40);
  assertStep43Contract(step43);
});

test("steps041 and 042 preserve class async and CSS separation contracts through the exact build", async () => {
  const step41 = await readFile(join(repoRoot, "codex", "assets", "steps", "step041.md"), "utf8");
  const step42 = await readFile(join(repoRoot, "codex", "assets", "steps", "step042.md"), "utf8");
  assertStep41Contract(step41);
  assertStep42Contract(step42);
});

test("step044 integrates routing before structure accessibility build and milestone gates", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step044.md"), "utf8");
  assertStep44Contract(content);
});

test("step043 rejects Korean and English reversals of its CSS to JavaScript responsibility gate", async () => {
  const original = await readFile(join(repoRoot, "codex", "assets", "steps", "step043.md"), "utf8");
  const correctGate = "CSS만으로 문제를 고칠 수 없고 그 문제가 data-rendering 책임에 속할 때에만 necessary visualization JavaScript를 변경한다.";
  const reversedKorean = original.replace(
    correctGate,
    "CSS만으로 의미나 data rendering을 고칠 수 있을 때에만 necessary visualization JavaScript를 변경한다."
  );
  const reversedEnglish = original.replace(
    correctGate,
    "Use necessary visualization JavaScript only when CSS alone can fix the issue and it belongs to data-rendering responsibility."
  );

  assert.notEqual(reversedKorean, original, "Korean reversal mutation did not change the document");
  assert.notEqual(reversedEnglish, original, "English reversal mutation did not change the document");
  assert.throws(() => assertStep43RemediationOrder(reversedKorean));
  assert.throws(() => assertStep43RemediationOrder(reversedEnglish));
  assertStep43RemediationOrder(original);
});

test("review semantic checks reject missing evidence, unavailable-visual bypasses, and reordered milestone gates", async () => {
  const paths = [39, 40, 41, 42, 43, 44].map((number) => (
    join(repoRoot, "codex", "assets", "steps", "step" + String(number).padStart(3, "0") + ".md")
  ));
  const [step39, step40, step41, step42, step43, step44] = await Promise.all(
    paths.map((path) => readFile(path, "utf8"))
  );
  const cases = [
    ["step039-no-retake", assertStep39Contract, step39.replace(/세 뷰포트\s*모두 다시 촬영/, "이전 캡처를 재사용")],
    ["step039-visual-bypass", assertStep39Contract, step39.replace("시각 검사 기능을 사용할 수 없으면", "시각 검사 기능을 사용할 수 없어도")],
    ["step040-missing-axis", assertStep40Contract, step40.replace("색상/대비", "색상")],
    ["step040-new-browsing", assertStep40Contract, step40.replace("새로운 browsing을 수행하지 않는다", "새로운 browsing을 수행한다")],
    ["step041-inline-script", assertStep41Contract, step41.replace(/inline script 구현을\s*금지한다/, "inline script 구현을 허용한다")],
    ["step041-unhandled", assertStep41Contract, step41.replace(/unhandled rejection을\s*남기지 않는다/, "unhandled rejection을 허용한다")],
    ["step042-inline-style", assertStep42Contract, step42.replace(/style attribute와 <style> element를\s*금지한다/, "style attribute와 <style> element를 허용한다")],
    ["step042-contrast", assertStep42Contract, step42.replace("contrast", "색감")],
    ["step043-unbounded", assertStep43Contract, step43.replace("최대 5라운드", "제한 없이 반복")],
    ["step043-visual-bypass", assertStep43Contract, step43.replace("시각 검사 기능을 사용할 수 없으면", "시각 검사 기능을 사용할 수 없어도")],
    ["step043-reference-over-contract", assertStep43Contract, step43.replace("누락 finding으로 판정하지 않는다", "누락 finding으로 판정한다")],
    ["step043-rewrites-step30", assertStep43Contract, step43.replace("30단계 산출물은 고치지 않는다", "30단계 산출물에 계약을 추가한다")],
    ["step044-premature-milestone", assertStep44Contract, step44.replace("모두 `PASS`인 뒤에만", "검사 전에")],
    ["step044-reordered", assertStep44Contract, step44
      .replace("## 현재 build 검증", "## __TEMP_BUILD__")
      .replace("## 독립 milestone 검증", "## 현재 build 검증")
      .replace("## __TEMP_BUILD__", "## 독립 milestone 검증")]
  ];

  for (const [name, contract, mutation] of cases) {
    const number = Number(name.slice(4, 7));
    const original = [step39, step40, step41, step42, step43, step44][number - 39];
    assert.notEqual(mutation, original, "mutation did not change review document: " + name);
    assert.throws(() => contract(mutation), undefined, "review semantic mutation escaped: " + name);
  }
});

const E2E_COMMAND_PATTERN = "^(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run) (?:e2e|test:e2e|e2e:[A-Za-z0-9][A-Za-z0-9:_-]*|[A-Za-z0-9][A-Za-z0-9:_-]*:e2e)$";

const EXPECTED_E2E_ACCEPTANCE_DESCRIPTIONS = {
  step045: {
    "e2e-test-report": "Stores the project-specific scenarios, edge cases, exact E2E command, attempts, and final independent verdict.",
    "project-e2e-command": "Runs the exact non-optional local project E2E script without implicit package download.",
    "project-e2e-runner-only": "Confirms only the project-declared E2E runner (`npm run e2e`) and preserved project configuration are used; the runner implementation is not inspected.",
    "bounded-browser-readiness": "Limits a missing browser installation to three normal-permission attempts and blocks if readiness is unavailable.",
    "dynamic-scenario-coverage": "Confirms scenarios derive from the topic, design, built application, and implemented user flows.",
    "edge-case-coverage": "Confirms at least two project-specific edge cases are exercised.",
    "independent-e2e-verifier": "Confirms a non-modifying independent verifier checks the entire E2E suite and evidence.",
    "bounded-pass-loop": "Requires an evidenced PASS within five rounds with no unresolved Critical or Important finding."
  },
  step046: {
    "detailed-e2e-report": "Stores the viewport, screen, and state matrix, exact command, screenshot manifest, rounds, and final verdict.",
    "e2e-primary-screenshot": "Stores the final primary detailed-E2E screenshot after any remediation.",
    "screenshot-e2e-command": "Runs the exact non-optional local project screenshot E2E script without implicit package download.",
    "viewport-screen-state-matrix": "Confirms every selected viewport, reachable screen, and meaningful state is exercised.",
    "independent-screenshot-verifier": "Confirms the non-modifying verifier is distinct from the detailed-E2E remediator.",
    "visual-inspection-required": "Confirms every final screenshot is actually opened and deterministic checks never replace visual inspection.",
    "bounded-pass-loop": "Requires an evidenced PASS within five rounds with no unresolved Critical or Important finding."
  },
  step047: {
    "keyboard-verification-report": "Stores the applicability matrix, interaction traces, screenshot manifest, rounds, and final verdict.",
    "keyboard-primary-before-screenshot": "Stores the final primary keyboard state before interaction.",
    "keyboard-primary-after-screenshot": "Stores the final primary keyboard state after interaction.",
    "keyboard-interaction-matrix": "Confirms Tab, Shift+Tab, Enter or Space, arrows, Escape, shortcuts, and input behavior are tested where applicable.",
    "input-three-state-evidence": "Confirms applicable input flows preserve before, during, and after visual evidence.",
    "genuine-na-only": "Allows N/A only with application evidence while accessibility requirements can never be N/A.",
    "independent-keyboard-verifier": "Confirms the non-modifying verifier is distinct from the keyboard remediator.",
    "visual-inspection-required": "Confirms every final keyboard screenshot is actually opened and deterministic checks never replace visual inspection.",
    "bounded-pass-loop": "Requires an evidenced PASS within five rounds with no unresolved Critical or Important finding."
  },
  step048: {
    "mouse-verification-report": "Stores the applicability matrix, interaction traces, screenshot manifest, rounds, and final verdict.",
    "mouse-primary-before-screenshot": "Stores the final primary mouse state before interaction.",
    "mouse-primary-after-screenshot": "Stores the final primary mouse state after interaction.",
    "mouse-interaction-matrix": "Confirms hover, click, context click, double click, drag and drop, and scroll are tested where applicable.",
    "intermediate-state-evidence": "Confirms applicable drag and scroll flows preserve intermediate visual evidence.",
    "genuine-na-only": "Allows N/A only when application evidence proves the interaction does not exist.",
    "independent-mouse-verifier": "Confirms the non-modifying verifier is distinct from the mouse remediator.",
    "visual-inspection-required": "Confirms every final mouse screenshot is actually opened and deterministic checks never replace visual inspection.",
    "bounded-pass-loop": "Requires an evidenced PASS within five rounds with no unresolved Critical or Important finding."
  },
  step049: {
    "design-visual-report": "Stores the deterministic component sample, eight-axis visual findings, remediation rounds, and final verdict.",
    "design-primary-screenshot": "Stores the final primary design screenshot after evidence-bound remediation.",
    "eight-axis-design-review": "Confirms layout, color, typography, responsive behavior, spacing, overlap or overflow, completeness, and interaction or accessibility.",
    "design-token-research-traceability": "Traces every finding to selected design tokens, persisted research, and an observed screenshot region.",
    "stable-component-sample": "Confirms a stable sorted sample covers min(10, component count) components without arbitrary font bans.",
    "independent-design-verifier": "Confirms the non-modifying design judge is distinct from the visual remediator.",
    "visual-inspection-required": "Confirms persisted evidence and every final screenshot are actually opened rather than inferred.",
    "bounded-pass-loop": "Requires an evidenced PASS within five rounds with no unresolved Critical or Important finding."
  },
  step050: {
    "console-error-report": "Stores the reachable-state manifest, redacted event findings, bounded settle evidence, rounds, and final verdict.",
    "final-quality-milestone": "Stores the third quality milestone only after console, final build, dist, and independent verification gates pass.",
    "final-dist-index-html": "Requires the final build-produced dist/index.html artifact.",
    "browser-output-report": "Requires passing desktop and mobile browser measurements bound to the final dist/index.html digest.",
    "console-errors-zero": "Confirms zero page errors, unhandled rejections, console errors, required-request failures, and crashes across every reachable state.",
    "final-build": "Runs the exact non-optional build script declared by the project manifest after console verification passes.",
    "final-dist-html-boundary": "Confirms the final dist/index.html is a regular nonempty file with valid HTML boundaries.",
    "reachable-state-manifest": "Confirms initial, navigation, prerequisite input, and hidden reachable states are enumerated and exercised.",
    "warning-classification": "Classifies every warning with evidence without silently treating an error as a warning.",
    "bounded-settle-no-fixed-sleep": "Confirms state-specific bounded settle conditions are used instead of fixed sleeps.",
    "secret-redaction": "Confirms reports redact credentials, tokens, cookies, authorization values, and sensitive query data.",
    "independent-console-verifier": "Confirms the non-modifying verifier is distinct from the console-error remediator.",
    "receipt-first-completion": "Confirms durable Step 50 receipt creation precedes completed state and any 50/50 report.",
    "pass-only-final-milestone": "Requires every mandatory gate to PASS before the final report and third milestone count as evidence.",
    "measured-quality-report": "Runtime-populated current measured-quality PASS with validated immutable report digest; required for every new completion.",
    "final-regression-report": "Runtime-populated final regression PASS binding all six matrices to the final HTML and immutable QA report digest; required for new completion.",
    "final-desktop-screenshot": "Records the current final browser screenshot for visual inspection.",
    "final-mobile-screenshot": "Records the current final browser screenshot for visual inspection.",
    "final-visual-inspection": "Confirms actual visual inspection of final desktop/mobile evidence and full screenshot/design regression matrices."
  }
};

function assertE2eAcceptanceDescriptions(steps) {
  const actual = Object.fromEntries(steps.map((step) => [
    step.id,
    Object.fromEntries(step.acceptance.map((item) => [item.id, item.description]))
  ]));
  assert.deepEqual(actual, EXPECTED_E2E_ACCEPTANCE_DESCRIPTIONS);
}

const E2E_ROLE_CONTRACTS = [
  { number: 45, worker: /E2E 실행·보정자 역할/, verifier: /E2E 독립 검증자 역할/ },
  { number: 46, worker: /상세 E2E 실행·보정자 역할/, verifier: /상세 E2E 독립 검증자 역할/ },
  { number: 47, worker: /키보드 실행·보정자 역할/, verifier: /키보드 독립 검증자 역할/ },
  { number: 48, worker: /마우스 실행·보정자 역할/, verifier: /마우스 독립 검증자 역할/ },
  { number: 49, worker: /디자인 보정자 역할/, verifier: /디자인 독립 검증자 역할/ },
  { number: 50, worker: /콘솔 오류 보정자 역할/, verifier: /콘솔 오류 독립 검증자 역할/ }
];

function assertE2eRoleContract(content, { worker, verifier }) {
  const roleSection = extractMarkdownSection(content, "실행 역할").replace(/\s+/g, " ");
  assert.match(roleSection, worker);
  assert.match(roleSection, verifier);
  assert.match(roleSection, /독립 검증자[^]*산출물과 application source를 수정하지 않는다/);
  assert.match(roleSection, /위임 기능을 사용할 수 없으면[^]*현재 실행자가[^]*두 역할을 명확히 분리[^]*순서대로 수행/);
  assert.match(roleSection, /별도 역할을 위임했다고 기록하지 않는다/);
  assertPlanningPermissionContract(content);
}

function projectE2eStep(step) {
  return {
    number: step.number,
    id: step.id,
    title: step.title,
    phase: step.phase,
    source: step.source,
    target: step.target,
    source_sha256: step.source_sha256,
    inputs: step.inputs,
    outputs: step.outputs,
    requires: step.requires,
    optional_requires: step.optional_requires,
    network: step.network,
    visual_review: step.visual_review,
    acceptance: step.acceptance.map((item) => ({
      id: item.id,
      kind: item.kind,
      required: item.required,
      ...(item.path === undefined ? {} : { path: item.path }),
      ...(item.command_pattern === undefined ? {} : { command_pattern: item.command_pattern }),
      ...(item.validator === undefined ? {} : { validator: item.validator })
    })),
    ported: step.ported,
    next: step.next
  };
}

const EXPECTED_E2E_ROWS = [
  {
    number: 45,
    id: "step045",
    title: "E2E 테스트",
    phase: "e2e",
    source: "assets/steps/step045.md",
    target: "codex/assets/steps/step045.md",
    source_sha256: "631828447c6154675d2f6b7a651717b9e211d1cc67ca62c829b65ecd20b34e9f",
    inputs: [
      "step_archive/TOPIC/TOPIC.md",
      "step_archive/step001_preflight.md",
      "step_archive/step030_레이아웃설계_chunk1.md",
      "step_archive/step030_전체설계_chunk1.md",
      "step_archive/step031_환경준비.md",
      "step_archive/step038_smoke_test.md",
      "dist/index.html",
      "step_archive/step044_routing검증.md",
      "step_archive/outputs/trust5_r2.md"
    ],
    outputs: ["step_archive/step045_e2e테스트결과.md"],
    requires: ["step001", "step030", "step031", "step038", "step044"],
    optional_requires: [],
    network: true,
    visual_review: false,
    acceptance: [
      { id: "e2e-test-report", kind: "artifact", required: true, path: "step_archive/step045_e2e테스트결과.md" },
      { id: "project-e2e-command", kind: "command", required: true, command_pattern: E2E_COMMAND_PATTERN },
      { id: "project-e2e-runner-only", kind: "check", required: true },
      { id: "bounded-browser-readiness", kind: "check", required: true },
      { id: "dynamic-scenario-coverage", kind: "check", required: true },
      { id: "edge-case-coverage", kind: "check", required: true },
      { id: "independent-e2e-verifier", kind: "check", required: true },
      { id: "bounded-pass-loop", kind: "check", required: true }
    ],
    ported: true,
    next: "step046"
  },
  {
    number: 46,
    id: "step046",
    title: "스크린샷 기반 상세 E2E 테스트",
    phase: "e2e",
    source: "assets/steps/step046.md",
    target: "codex/assets/steps/step046.md",
    source_sha256: "0ea05ced6d5fd23280ead9f00a7327548966317489e71eeabbbafcaf9b415d80",
    inputs: [
      "step_archive/step030_레이아웃설계_chunk1.md",
      "step_archive/step030_전체설계_chunk1.md",
      "step_archive/step038_smoke_test.md",
      "dist/index.html",
      "step_archive/outputs/step039_검증_r1.md",
      "step_archive/step044_routing검증.md",
      "step_archive/outputs/trust5_r2.md",
      "step_archive/step045_e2e테스트결과.md"
    ],
    outputs: [
      "step_archive/step046_screenshot_e2e.md",
      "step_archive/screenshots/e2e/step046-primary.png"
    ],
    requires: ["step030", "step038", "step039", "step044", "step045"],
    optional_requires: [],
    network: false,
    visual_review: true,
    acceptance: [
      { id: "detailed-e2e-report", kind: "artifact", required: true, path: "step_archive/step046_screenshot_e2e.md" },
      { id: "e2e-primary-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/e2e/step046-primary.png" },
      { id: "screenshot-e2e-command", kind: "command", required: true, command_pattern: E2E_COMMAND_PATTERN },
      { id: "viewport-screen-state-matrix", kind: "check", required: true },
      { id: "independent-screenshot-verifier", kind: "check", required: true },
      { id: "visual-inspection-required", kind: "check", required: true },
      { id: "bounded-pass-loop", kind: "check", required: true }
    ],
    ported: true,
    next: "step047"
  },
  {
    number: 47,
    id: "step047",
    title: "키보드 인터랙션 시각 검증",
    phase: "e2e",
    source: "assets/steps/step047.md",
    target: "codex/assets/steps/step047.md",
    source_sha256: "f2a50ec4541efb9512aef33b87ba1fdd1dbed10adf596bc17fa2ca433a799eab",
    inputs: [
      "step_archive/step030_레이아웃설계_chunk1.md",
      "step_archive/step038_smoke_test.md",
      "dist/index.html",
      "step_archive/step044_routing검증.md",
      "step_archive/outputs/trust5_r2.md",
      "step_archive/step046_screenshot_e2e.md",
      "step_archive/screenshots/e2e/step046-primary.png"
    ],
    outputs: [
      "step_archive/step047_keyboard검증.md",
      "step_archive/screenshots/keyboard/step047-primary-before.png",
      "step_archive/screenshots/keyboard/step047-primary-after.png"
    ],
    requires: ["step030", "step038", "step044", "step046"],
    optional_requires: [],
    network: false,
    visual_review: true,
    acceptance: [
      { id: "keyboard-verification-report", kind: "artifact", required: true, path: "step_archive/step047_keyboard검증.md" },
      { id: "keyboard-primary-before-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/keyboard/step047-primary-before.png" },
      { id: "keyboard-primary-after-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/keyboard/step047-primary-after.png" },
      { id: "keyboard-interaction-matrix", kind: "check", required: true },
      { id: "input-three-state-evidence", kind: "check", required: true },
      { id: "genuine-na-only", kind: "check", required: true },
      { id: "independent-keyboard-verifier", kind: "check", required: true },
      { id: "visual-inspection-required", kind: "check", required: true },
      { id: "bounded-pass-loop", kind: "check", required: true }
    ],
    ported: true,
    next: "step048"
  },
  {
    number: 48,
    id: "step048",
    title: "마우스 인터랙션 시각 검증",
    phase: "e2e",
    source: "assets/steps/step048.md",
    target: "codex/assets/steps/step048.md",
    source_sha256: "57025c19da2d0e672975c117d69654f84de0053e4a874d880878346541b37f78",
    inputs: [
      "step_archive/step030_레이아웃설계_chunk1.md",
      "step_archive/step038_smoke_test.md",
      "dist/index.html",
      "step_archive/step044_routing검증.md",
      "step_archive/outputs/trust5_r2.md",
      "step_archive/step046_screenshot_e2e.md",
      "step_archive/screenshots/e2e/step046-primary.png",
      "step_archive/step047_keyboard검증.md",
      "step_archive/screenshots/keyboard/step047-primary-before.png",
      "step_archive/screenshots/keyboard/step047-primary-after.png"
    ],
    outputs: [
      "step_archive/step048_마우스검증.md",
      "step_archive/screenshots/mouse/step048-primary-before.png",
      "step_archive/screenshots/mouse/step048-primary-after.png"
    ],
    requires: ["step030", "step038", "step044", "step046", "step047"],
    optional_requires: [],
    network: false,
    visual_review: true,
    acceptance: [
      { id: "mouse-verification-report", kind: "artifact", required: true, path: "step_archive/step048_마우스검증.md" },
      { id: "mouse-primary-before-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/mouse/step048-primary-before.png" },
      { id: "mouse-primary-after-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/mouse/step048-primary-after.png" },
      { id: "mouse-interaction-matrix", kind: "check", required: true },
      { id: "intermediate-state-evidence", kind: "check", required: true },
      { id: "genuine-na-only", kind: "check", required: true },
      { id: "independent-mouse-verifier", kind: "check", required: true },
      { id: "visual-inspection-required", kind: "check", required: true },
      { id: "bounded-pass-loop", kind: "check", required: true }
    ],
    ported: true,
    next: "step049"
  },
  {
    number: 49,
    id: "step049",
    title: "디자인 시각 검증 (독립 검증 루프)",
    phase: "e2e",
    source: "assets/steps/step049.md",
    target: "codex/assets/steps/step049.md",
    source_sha256: "ec9c64fb7ca4c88d0d55d1433b31338995222918161f87b3c82204bff5c5f4f4",
    inputs: [
      "step_archive/step030_레이아웃설계_chunk1.md",
      "step_archive/step030_전체설계_chunk1.md",
      "step_archive/step038_smoke_test.md",
      "dist/index.html",
      "step_archive/outputs/step040_검증.md",
      "step_archive/screenshots/compare-awwwards-applied-r1.png",
      "step_archive/outputs/step043_검증_r1.md",
      "step_archive/step044_routing검증.md",
      "step_archive/outputs/trust5_r2.md",
      "step_archive/step047_keyboard검증.md",
      "step_archive/step048_마우스검증.md"
    ],
    outputs: [
      "step_archive/outputs/step049_검증_r1.md",
      "step_archive/screenshots/design/step049-primary-r1.png"
    ],
    requires: ["step030", "step038", "step040", "step043", "step044", "step047", "step048"],
    optional_requires: [],
    network: true,
    visual_review: true,
    acceptance: [
      { id: "design-visual-report", kind: "artifact", required: true, path: "step_archive/outputs/step049_검증_r1.md" },
      { id: "design-primary-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/design/step049-primary-r1.png" },
      { id: "eight-axis-design-review", kind: "check", required: true },
      { id: "design-token-research-traceability", kind: "check", required: true },
      { id: "stable-component-sample", kind: "check", required: true },
      { id: "independent-design-verifier", kind: "check", required: true },
      { id: "visual-inspection-required", kind: "check", required: true },
      { id: "bounded-pass-loop", kind: "check", required: true }
    ],
    ported: true,
    next: "step050"
  },
  {
    number: 50,
    id: "step050",
    title: "콘솔 에러 수집 및 해결",
    phase: "e2e",
    source: "assets/steps/step050.md",
    target: "codex/assets/steps/step050.md",
    source_sha256: "892710c82b634ed4658966167c8f560e4f460ed36b1149a54116fc175a747c5d",
    inputs: [
      "step_archive/step038_smoke_test.md",
      "dist/index.html",
      "step_archive/step044_routing검증.md",
      "step_archive/outputs/trust5_r2.md",
      "step_archive/step045_e2e테스트결과.md",
      "step_archive/step046_screenshot_e2e.md",
      "step_archive/screenshots/e2e/step046-primary.png",
      "step_archive/step047_keyboard검증.md",
      "step_archive/screenshots/keyboard/step047-primary-before.png",
      "step_archive/screenshots/keyboard/step047-primary-after.png",
      "step_archive/step048_마우스검증.md",
      "step_archive/screenshots/mouse/step048-primary-before.png",
      "step_archive/screenshots/mouse/step048-primary-after.png",
      "step_archive/outputs/step049_검증_r1.md",
      "step_archive/screenshots/design/step049-primary-r1.png"
    ],
    outputs: [
      "step_archive/outputs/step050_콘솔에러.md",
      "step_archive/outputs/trust5_r3.md",
      "step_archive/outputs/browser-output.json",
      "step_archive/screenshots/verified-desktop.png",
      "step_archive/screenshots/verified-mobile.png"
    ],
    requires: ["step038", "step044", "step045", "step046", "step047", "step048", "step049"],
    optional_requires: [],
    network: false,
    visual_review: true,
    acceptance: [
      { id: "console-error-report", kind: "artifact", required: true, path: "step_archive/outputs/step050_콘솔에러.md" },
      { id: "final-quality-milestone", kind: "artifact", required: true, path: "step_archive/outputs/trust5_r3.md" },
      { id: "final-dist-index-html", kind: "artifact", required: true, path: "dist/index.html", validator: "html-document" },
      { id: "browser-output-report", kind: "artifact", required: true, path: "step_archive/outputs/browser-output.json", validator: "browser-output" },
      { id: "console-errors-zero", kind: "check", required: true },
      { id: "final-build", kind: "command", required: true, command_pattern: REVIEW_BUILD_COMMAND_PATTERN },
      { id: "final-dist-html-boundary", kind: "check", required: true },
      { id: "reachable-state-manifest", kind: "check", required: true },
      { id: "warning-classification", kind: "check", required: true },
      { id: "bounded-settle-no-fixed-sleep", kind: "check", required: true },
      { id: "secret-redaction", kind: "check", required: true },
      { id: "independent-console-verifier", kind: "check", required: true },
      { id: "receipt-first-completion", kind: "check", required: true },
      { id: "pass-only-final-milestone", kind: "check", required: true },
      { id: "measured-quality-report", kind: "check", required: false },
      { id: "final-regression-report", kind: "check", required: false },
      { id: "final-desktop-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/verified-desktop.png" },
      { id: "final-mobile-screenshot", kind: "artifact", required: true, path: "step_archive/screenshots/verified-mobile.png" },
      { id: "final-visual-inspection", kind: "check", required: true }
    ],
    ported: true,
    next: null
  }
];

test("e2e batch declares exact metadata, evidence contracts, descriptions, and visual set", async () => {
  await assertE2eTargetDigests(repoRoot);
  const report = await validateStepBatch(repoRoot, [45, 46, 47, 48, 49, 50]);
  assertE2eAcceptanceDescriptions(report.steps);
  assert.deepEqual(report.steps.map(projectE2eStep), EXPECTED_E2E_ROWS);
  assert.deepEqual(
    report.steps.filter((step) => step.visual_review).map((step) => step.number),
    [46, 47, 48, 49, 50]
  );
});

test("e2e source hashes bind reviewed source steps 045 through 050", async () => {
  const index = await loadIndex(repoRoot);
  const hashes = await recordSourceHashes(repoRoot, index.steps.slice(44, 50));
  assert.deepEqual(hashes, {
    step045: "631828447c6154675d2f6b7a651717b9e211d1cc67ca62c829b65ecd20b34e9f",
    step046: "0ea05ced6d5fd23280ead9f00a7327548966317489e71eeabbbafcaf9b415d80",
    step047: "f2a50ec4541efb9512aef33b87ba1fdd1dbed10adf596bc17fa2ca433a799eab",
    step048: "57025c19da2d0e672975c117d69654f84de0053e4a874d880878346541b37f78",
    step049: "ec9c64fb7ca4c88d0d55d1433b31338995222918161f87b3c82204bff5c5f4f4",
    step050: "892710c82b634ed4658966167c8f560e4f460ed36b1149a54116fc175a747c5d"
  });
});

test("e2e acceptance descriptions reject placeholder-wide mutation", async () => {
  const index = await loadIndex(repoRoot);
  const mutated = structuredClone(index.steps.slice(44, 50));
  for (const step of mutated) {
    for (const item of step.acceptance ?? []) item.description = "x";
  }
  assert.throws(() => assertE2eAcceptanceDescriptions(mutated));
});

const EXPECTED_E2E_TARGET_SHA256 = Object.freeze({
  step045: "b90596f8a6ed79ad9f66a625772e9837f17e27e54eefa664f729eab5a13ea2f4",
  step046: "187a619f02da34101426d23f466182758b7d0b6bc0977ab3518c8c6bb2bfd93d",
  step047: "d2ed158f4fb15f52e21d76438776bbe0b1e5a0124a46eb4e7bd511c31398dfde",
  step048: "d858de0ea976dbce2a85c62ec71722964d2615528c2235fdf8e877b1d2a1558b",
  step049: "764cf2132e9197a95a84c9e65d549956e7dc6ef37ee1ea513e48d649987ece1b",
  step050: "7f7c186628672579fc4d6589fd6b9fe3e7e825142ffca429eba1f50184501177"
});

async function assertE2eTargetDigests(root) {
  for (const [id, expected] of Object.entries(EXPECTED_E2E_TARGET_SHA256)) {
    const relativePath = "codex/assets/steps/" + id + ".md";
    let bytes;
    try {
      bytes = await readFile(join(root, relativePath));
    } catch (error) {
      const actual = "unreadable:" + (error?.code ?? "unknown");
      throw new Error(id + " target digest mismatch: path=" + relativePath + " expected=" + expected + " actual=" + actual);
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      throw new Error(id + " target digest mismatch: path=" + relativePath + " expected=" + expected + " actual=" + actual);
    }
  }
}

function assertBoundedE2eLoop(section, { visual = false } = {}) {
  const normalized = section.replace(/\s+/g, " ");
  assert.match(normalized, /최대 5라운드/);
  assert.match(normalized, /`Critical`[^]*`Important`[^]*하나라도 미해결[^]*차단/);
  assert.match(normalized, /필수 입력[^]*필수 증거[^]*실행 capability[^]*없거나 사용할 수 없으면[^]*차단/);
  assert.match(normalized, /`PASS`[^]*경우에만/);
  assert.match(normalized, /스킵이나 미해결 finding은 통과 또는 완료 증거가 아니다/);
  assert.doesNotMatch(normalized, /(?:무한|제한 없이)[^.]{0,80}반복|3[^.]{0,80}(?:실패|미수정)[^.]{0,80}(?:진행|스킵|완료)/);
  assert.doesNotMatch(normalized, /스킵[^.]{0,100}(?:해도|하고도|이면)[^.]{0,50}(?:통과|완료)|미해결[^.]{0,100}(?:있어도|남아도)[^.]{0,50}(?:통과|완료)/);
  if (visual) {
    assert.match(normalized, /시각 검사 기능을 사용할 수 없으면[^.]*차단/);
    assert.match(normalized, /결정적 DOM[^]*file[^]*실제로 이미지를 여는 시각 검사를 대체하지 못한다/i);
    assert.match(normalized, /실제로 열어/);
  }
}

function assertStep45Contract(content) {
  const sections = extractOrderedMarkdownSections(content, [
    "목표",
    "입력과 산출물",
    "실행 역할",
    "사전 준비와 시나리오 설계",
    "전체 E2E 실행과 독립 검증",
    "완료 조건"
  ]);
  const readiness = sections["사전 준비와 시나리오 설계"].replace(/\s+/g, " ");
  const execution = sections["전체 E2E 실행과 독립 검증"].replace(/\s+/g, " ");
  assert.match(readiness, /project manifest[^]*lockfile[^]*선언한 E2E 러너/i);
  assert.match(readiness, /browser[^]*없으면[^]*최대 3회[^]*정상 권한[^]*설치 시도/i);
  assert.match(readiness, /implicit package download[^]*금지/i);
  assert.match(readiness, /기존 러너 configuration[^]*보존/i);
  assert.match(readiness, /topic[^]*design[^]*built application[^]*user flow/i);
  assert.match(readiness, /project-specific edge case[^]*최소 2개/i);
  assert.doesNotMatch(readiness, /npx(?:\.cmd)?(?:\s+--yes)?/i);
  assert.match(execution, /project manifest[^]*정확한 E2E script[^]*전체 suite[^]*exit code 0/i);
  assert.match(execution, /실패 원인[^]*최소 변경[^]*다시 전체 suite/i);
  assertBoundedE2eLoop(sections["전체 E2E 실행과 독립 검증"]);
}

function assertStep46Contract(content) {
  const sections = extractOrderedMarkdownSections(content, [
    "목표",
    "입력과 산출물",
    "실행 역할",
    "화면·뷰포트·상태 행렬",
    "스크린샷 E2E와 시각 검증",
    "완료 조건"
  ]);
  const matrix = sections["화면·뷰포트·상태 행렬"].replace(/\s+/g, " ");
  const loop = sections["스크린샷 E2E와 시각 검증"].replace(/\s+/g, " ");
  assert.match(matrix, /30단계[^]*39단계[^]*viewport[^]*screen[^]*state/i);
  assert.match(matrix, /viewport × screen × state/i);
  assert.match(loop, /project manifest[^]*정확한 E2E script[^]*exit code 0/i);
  assert.match(loop, /step_archive\/screenshots\/e2e\/step046-primary\.png/);
  assert.match(loop, /matrix[^]*모든 최종 screenshot[^]*실제로 열어/i);
  assertBoundedE2eLoop(sections["스크린샷 E2E와 시각 검증"], { visual: true });
}

function assertStep47Contract(content) {
  const sections = extractOrderedMarkdownSections(content, [
    "목표",
    "입력과 산출물",
    "실행 역할",
    "키보드 검증 행렬",
    "스크린샷과 독립 시각 검증",
    "완료 조건"
  ]);
  const matrix = sections["키보드 검증 행렬"].replace(/\s+/g, " ");
  const loop = sections["스크린샷과 독립 시각 검증"].replace(/\s+/g, " ");
  for (const requirement of [
    /Tab/, /Shift\+Tab/, /Enter[^]*Space/, /arrow/i, /Escape/, /shortcut/i, /input/i
  ]) assert.match(matrix, requirement);
  assert.match(matrix, /입력 전[^]*입력 중[^]*입력 완료 후/);
  assert.match(matrix, /N\/A[^]*application evidence[^]*실제로 존재하지 않/i);
  assert.match(matrix, /accessibility[^]*N\/A[^]*허용하지 않는다/i);
  assert.match(loop, /step047-primary-before\.png[^]*step047-primary-after\.png/);
  assert.match(loop, /각 적용 항목[^]*전후 screenshot[^]*input[^]*세 상태/i);
  assertBoundedE2eLoop(sections["스크린샷과 독립 시각 검증"], { visual: true });
}

function assertStep48Contract(content) {
  const sections = extractOrderedMarkdownSections(content, [
    "목표",
    "입력과 산출물",
    "실행 역할",
    "마우스 검증 행렬",
    "스크린샷과 독립 시각 검증",
    "완료 조건"
  ]);
  const matrix = sections["마우스 검증 행렬"].replace(/\s+/g, " ");
  const loop = sections["스크린샷과 독립 시각 검증"].replace(/\s+/g, " ");
  for (const requirement of [
    /hover/i, /click/i, /context click/i, /double click/i, /drag[^]*drop/i, /scroll/i
  ]) assert.match(matrix, requirement);
  assert.match(matrix, /drag[^]*중간 상태[^]*scroll[^]*중간 상태/i);
  assert.match(matrix, /N\/A[^]*application evidence[^]*실제로 존재하지 않/i);
  assert.match(loop, /step048-primary-before\.png[^]*step048-primary-after\.png/);
  assert.match(loop, /각 적용 항목[^]*전후 screenshot[^]*drag[^]*scroll[^]*중간 screenshot/i);
  assertBoundedE2eLoop(sections["스크린샷과 독립 시각 검증"], { visual: true });
}

function assertStep49Contract(content) {
  const sections = extractOrderedMarkdownSections(content, [
    "목표",
    "입력과 산출물",
    "실행 역할",
    "표본과 여덟 축",
    "독립 디자인 검증 루프",
    "완료 조건"
  ]);
  const sample = sections["표본과 여덟 축"].replace(/\s+/g, " ");
  const loop = sections["독립 디자인 검증 루프"].replace(/\s+/g, " ");
  assert.match(sample, /stable sort[^]*min\(10, component count\)/i);
  for (const axis of [
    "layout",
    "color",
    "typography",
    "responsive",
    "spacing",
    "overlap/overflow",
    "completeness",
    "interaction/accessibility"
  ]) assert.match(sample, new RegExp(axis.replace("/", "\\/"), "i"));
  assert.match(sample, /selected design token[^]*persisted research evidence/i);
  assert.match(sample, /font family[^]*이름만으로 금지하지 않는다/i);
  assert.match(sample, /`step_archive\/step030_레이아웃설계_chunk1\.md`[^]*`harness50-design-contract`/);
  assert.match(sample, /`adopted`가 false[^]*최소 `Important` finding/);
  assert.match(sample, /계약에 없는 스타일 선호는 finding으로 만들지 않는다/);
  assert.match(loop, /step_archive\/screenshots\/design\/step049-primary-r1\.png/);
  assert.match(loop, /독립 검증자[^]*판정[^]*보정자[^]*수정/i);
  assert.match(loop, /persisted evidence[^]*최종 screenshot[^]*실제로 열어/i);
  assertBoundedE2eLoop(sections["독립 디자인 검증 루프"], { visual: true });
}

function assertStep50Contract(content) {
  const sections = extractOrderedMarkdownSections(content, [
    "목표",
    "입력과 산출물",
    "실행 역할",
    "도달 가능 상태와 오류 수집",
    "최종 build와 완료 순서",
    "완료 조건"
  ]);
  const collection = sections["도달 가능 상태와 오류 수집"].replace(/\s+/g, " ");
  const completion = sections["최종 build와 완료 순서"].replace(/\s+/g, " ");
  assert.match(collection, /reachable-state manifest[^]*initial[^]*navigation[^]*input prerequisite[^]*hidden/i);
  assert.match(collection, /pageerror[^]*unhandled rejection[^]*console\.error[^]*required-request failure[^]*crash/i);
  assert.match(collection, /모두 0개/);
  assert.match(collection, /warning[^]*근거[^]*분류/);
  assert.match(collection, /bounded settle condition[^]*fixed sleep[^]*사용하지 않는다/i);
  assert.match(collection, /credential[^]*token[^]*cookie[^]*authorization[^]*sensitive query[^]*redact/i);
  assertBoundedE2eLoop(sections["도달 가능 상태와 오류 수집"]);
  assert.match(completion, /console 검증[^]*`PASS`[^]*project manifest[^]*정확한 build 명령[^]*exit code 0/i);
  assert.match(completion, /dist\/index\.html[^]*일반 파일[^]*0바이트보다 크[^]*<html[^]*<\/html>/i);
  assert.match(completion, /모든 필수 gate[^]*`PASS`[^]*trust5_r3\.md/);
  assert.match(completion, /현재 attempt evidence[^]*상태 관리자[^]*검증[^]*50단계 영수증[^]*내구성 있게 먼저 기록/);
  assert.match(completion, /영수증[^]*completed[^]*current_step:null[^]*completed_at/);
  assert.match(completion, /crash[^]*영수증에서 앞으로 reconcile/i);
  assert.match(completion, /영수증[^]*complete[^]*실패[^]*50\/50[^]*보고하지 않는다/);
  assert.match(completion, /영수증은 단계 artifact가 아니며[^]*문서[^]*직접[^]*상태나 영수증을 쓰지 않는다/);
  assert.match(completion, /`Stop`[^]*영수증[^]*completed[^]*모두 확인[^]*종료를 허용/);
  assert.match(completion, /continuation[^]*발행하지 않고[^]*미래 단계[^]*읽지 않는다/i);
  assert.doesNotMatch(completion, /completed[^.]{0,100}영수증[^.]{0,80}(?:나중|후)/);
}

test("e2e documents bind exact frontmatter titles and only their current Step heading", async () => {
  for (const row of EXPECTED_E2E_ROWS) {
    const content = await readFile(join(repoRoot, row.target), "utf8");
    assert.deepEqual(parseStepDocument(content), {
      frontmatter: { name: row.id, phase: "e2e" },
      titles: [{ number: row.number, title: row.title }],
      referencedSteps: [row.number]
    });
  }
});

test("e2e outputs are unique required artifacts with closed direct dependencies", async () => {
  const index = await loadIndex(repoRoot);
  const e2e = (await validateStepBatch(repoRoot, [45, 46, 47, 48, 49, 50])).steps;
  const ownersByOutput = new Map();
  for (const step of index.steps) {
    for (const output of step.outputs ?? []) {
      const owners = ownersByOutput.get(output) ?? [];
      owners.push(step.id);
      ownersByOutput.set(output, owners);
    }
  }
  const ownerByOutput = new Map(
    [...ownersByOutput].map(([output, owners]) => [output, owners.length === 1 ? owners[0] : null])
  );
  const allOutputs = e2e.flatMap((step) => step.outputs);
  assert.equal(new Set(allOutputs).size, allOutputs.length);
  assert.deepEqual(ownersByOutput.get("dist/index.html"), ["step038"]);
  for (const step of e2e) {
    assert.ok(step.requires.includes("step038"), step.id + " must directly require the dist owner");
    for (const output of step.outputs) {
      assert.deepEqual(ownersByOutput.get(output), [step.id], output + " must have exactly one canonical owner");
      assert.ok(step.acceptance.some((item) => (
        item.kind === "artifact" && item.required && item.path === output
      )), step.id + " output lacks required artifact evidence: " + output);
    }
    for (const input of step.inputs) {
      const owner = ownerByOutput.get(input);
      if (owner) assert.ok(step.requires.includes(owner), step.id + " does not require the owner of " + input);
    }
    for (const dependency of step.requires) {
      assert.ok(
        step.inputs.some((input) => ownerByOutput.get(input) === dependency),
        step.id + " has an unbound dependency " + dependency
      );
    }
  }
});

test("e2e instructions stay provider-neutral, permission-preserving, receipt-owned, and current-step scoped", async () => {
  const e2e = (await validateStepBatch(repoRoot, [45, 46, 47, 48, 49, 50])).steps;
  for (const step of e2e) {
    const content = await readFile(join(repoRoot, step.target), "utf8");
    assert.deepEqual(scanForbiddenTokens(content), []);
    assert.doesNotMatch(content, /(?:progress|state)\.json|\.harness50-codex|transcript/i);
    assert.doesNotMatch(content, /\/(?:webapp|harness-status|harness-reset)\b|\$(?:webapp|harness(?:14|20|36|50)-(?:status|reset))\b/i);
    assert.doesNotMatch(content, /(?:다음|후속)\s*(?:Step|단계)|\bnext\s+step\b/i);
    assert.doesNotMatch(content, /\b(?:npx|html-bundler)\b|step\s*0?(?:69|81|84|89|104|107)|retired validator/i);
    assert.doesNotMatch(content, /직접\s*(?:연쇄|chain)|hidden state|스마트\s*스킵|무한\s*반복|3[^.\n]{0,80}실패[^.\n]{0,80}(?:계속|진행)/i);
    assertE2eRoleContract(content, E2E_ROLE_CONTRACTS.find((item) => item.number === step.number));
    const normalized = content.replace(/\s+/g, " ");
    assert.match(normalized, /수락 증거[^]*현재 단계에서 멈춘다/);
    if (step.number < 50) assert.match(normalized, /workflow 상태와 영수증[^]*진행을 소유/);
  }
});

test("e2e roles reject removals, false delegation, auto approval, and permission bypass", async () => {
  for (const contract of E2E_ROLE_CONTRACTS) {
    const id = "step" + String(contract.number).padStart(3, "0");
    const original = await readFile(join(repoRoot, "codex", "assets", "steps", id + ".md"), "utf8");
    const mutations = {
      workerRemoved: original.replace(contract.worker, "삭제된 실행 역할"),
      verifierRemoved: original.replace(contract.verifier, "삭제된 검증 역할"),
      fallbackRemoved: original.replace(/위임 기능을 사용할 수\s*없으면[^.]+\./, "위임할 수 없으면 검증 없이 완료한다."),
      falseDelegation: original.replace(/별도 역할을\s*위임했다고\s*기록하지\s*않는다/, "별도 역할을 위임했다고 기록한다"),
      autoApproval: original.replace("## 입력과 산출물", "안전 명령은 자동 승인한다.\n\n## 입력과 산출물"),
      permissionBypass: original.replace("## 입력과 산출물", "권한 확인 절차를 우회한다.\n\n## 입력과 산출물")
    };
    for (const [name, mutation] of Object.entries(mutations)) {
      assert.notEqual(mutation, original, id + " mutation did not change content: " + name);
      assert.throws(
        () => assertE2eRoleContract(mutation, contract),
        undefined,
        id + " role mutation escaped: " + name
      );
    }
  }
});

test("e2e command patterns are anchored, local-script only, and final build matches earlier gates", async () => {
  const steps = (await validateStepBatch(repoRoot, [38, 44, 45, 46, 50])).steps;
  const patterns = steps.map((step) => step.acceptance
    .filter((item) => item.kind === "command")
    .map((item) => [item.id, item.command_pattern]));
  assert.deepEqual(patterns, [
    [["project-build-command", REVIEW_BUILD_COMMAND_PATTERN]],
    [["project-build-command", REVIEW_BUILD_COMMAND_PATTERN]],
    [["project-e2e-command", E2E_COMMAND_PATTERN]],
    [["screenshot-e2e-command", E2E_COMMAND_PATTERN]],
    [["final-build", REVIEW_BUILD_COMMAND_PATTERN]]
  ]);
  for (const entries of patterns) {
    for (const [, pattern] of entries) {
      assert.match(pattern, /^\^/);
      assert.match(pattern, /\$$/);
      assert.doesNotThrow(() => new RegExp(pattern));
    }
  }
  const e2eMatcher = new RegExp(E2E_COMMAND_PATTERN);
  assert.equal(e2eMatcher.test("npm run test:e2e"), true);
  assert.equal(e2eMatcher.test("pnpm run app:e2e"), true);
  assert.equal(e2eMatcher.test("npx playwright test"), false);
  assert.equal(e2eMatcher.test("npm run test:e2e --if-present"), false);
});

test("steps045 through 050 preserve their section-local E2E and final lifecycle contracts", async () => {
  const paths = [45, 46, 47, 48, 49, 50].map((number) => (
    join(repoRoot, "codex", "assets", "steps", "step" + String(number).padStart(3, "0") + ".md")
  ));
  const [step45, step46, step47, step48, step49, step50] = await Promise.all(
    paths.map((path) => readFile(path, "utf8"))
  );
  assertStep45Contract(step45);
  assertStep46Contract(step46);
  assertStep47Contract(step47);
  assertStep48Contract(step48);
  assertStep49Contract(step49);
  assertStep50Contract(step50);
});

test("e2e semantic checks reject bypasses, missing interactions, weak sampling, and premature completion", async () => {
  const paths = [45, 46, 47, 48, 49, 50].map((number) => (
    join(repoRoot, "codex", "assets", "steps", "step" + String(number).padStart(3, "0") + ".md")
  ));
  const [step45, step46, step47, step48, step49, step50] = await Promise.all(
    paths.map((path) => readFile(path, "utf8"))
  );
  const cases = [
    ["step045-implicit-download", assertStep45Contract, step45.replace(/implicit package\s*download을 금지/, "implicit package download을 허용")],
    ["step045-unbounded", assertStep45Contract, step45.replace("최대 5라운드", "제한 없이 반복")],
    ["step046-no-open", assertStep46Contract, step46.replace(/모든 최종 screenshot을 실제로\s*열어/, "모든 최종 screenshot의 파일 존재만 확인해")],
    ["step046-visual-bypass", assertStep46Contract, step46.replace("시각 검사 기능을 사용할 수 없으면", "시각 검사 기능을 사용할 수 없어도")],
    ["step047-missing-shift-tab", assertStep47Contract, step47.replace("Shift+Tab", "역방향 키")],
    ["step047-accessibility-na", assertStep47Contract, step47.replace(/accessibility\s*항목에는 N\/A를 허용하지 않는다/, "accessibility 항목도 N/A로 끝낼 수 있다")],
    ["step048-missing-intermediate", assertStep48Contract, step48.replace("drag와 scroll에는 중간 screenshot", "drag와 scroll에는 마지막 screenshot")],
    ["step048-false-na", assertStep48Contract, step48.replace("실제로 존재하지 않음을", "검사가 어려움을")],
    ["step049-small-sample", assertStep49Contract, step49.replace("min(10, component count)", "min(3, component count)")],
    ["step049-font-ban", assertStep49Contract, step49.replace(/이름만으로 금지하지\s*않는다/, "이름만으로 금지한다")],
    ["step049-advisory-exclusion", assertStep49Contract, step49.replace("최소 `Important` finding", "advisory 의견")],
    ["step050-fixed-sleep", assertStep50Contract, step50.replace(/fixed sleep은\s*사용하지 않는다/, "fixed sleep을 사용한다")],
    ["step050-premature-milestone", assertStep50Contract, step50.replace(/모든\s*필수 gate가 `PASS`인 뒤에만/, "console 검사 전에도")],
    ["step050-receipt-after-complete", assertStep50Contract, step50.replace("내구성 있게 먼저 기록한다", "completed 뒤에 기록한다")],
    ["step050-report-without-receipt", assertStep50Contract, step50.replace("50/50을 보고하지 않는다", "50/50을 보고한다")]
  ];
  const originals = [step45, step46, step47, step48, step49, step50];
  for (const [name, contract, mutation] of cases) {
    const number = Number(name.slice(4, 7));
    assert.notEqual(mutation, originals[number - 45], "mutation did not change E2E document: " + name);
    assert.throws(() => contract(mutation), undefined, "E2E semantic mutation escaped: " + name);
  }
});

test("e2e target digest seal rejects unsafe and benign byte mutations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness50-e2e-digests-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "codex", "assets", "steps"), { recursive: true });
  const cases = [
    [45, "Implicit package download is allowed."],
    [46, "Visual inspection may be skipped."],
    [47, "Accessibility checks may be N/A."],
    [48, "Intermediate drag and scroll evidence is optional."],
    [49, "The verifier may edit application source."],
    [50, "Completed state may be written before the receipt."]
  ];
  const originals = new Map();
  for (const [number] of cases) {
    const id = "step" + String(number).padStart(3, "0");
    const relativePath = "codex/assets/steps/" + id + ".md";
    const bytes = await readFile(join(repoRoot, relativePath));
    originals.set(id, bytes);
    await writeFile(join(root, relativePath), bytes);
  }
  const escaped = [];
  const wrongDiagnostics = [];
  for (const [number, contradiction] of cases) {
    const id = "step" + String(number).padStart(3, "0");
    const relativePath = "codex/assets/steps/" + id + ".md";
    const original = originals.get(id);
    const mutations = [
      ["unsafe-contradiction", Buffer.concat([original, Buffer.from("\n" + contradiction + "\n")])],
      ["benign-whitespace", Buffer.concat([original, Buffer.from("\n")])]
    ];
    for (const [name, mutated] of mutations) {
      await writeFile(join(root, relativePath), mutated);
      const actual = createHash("sha256").update(mutated).digest("hex");
      const expectedMessage = id + " target digest mismatch: path=" + relativePath
        + " expected=" + EXPECTED_E2E_TARGET_SHA256[id] + " actual=" + actual;
      try {
        await assertE2eTargetDigests(root);
        escaped.push(id + ":" + name);
      } catch (error) {
        if (error.message !== expectedMessage) wrongDiagnostics.push(id + ":" + name + ":" + error.message);
      } finally {
        await writeFile(join(root, relativePath), original);
      }
    }
  }
  assert.deepEqual({ escaped, wrongDiagnostics }, { escaped: [], wrongDiagnostics: [] });
});

const BACKEND_LOCK_COMMAND = 'node scripts/verify-output.mjs --probe --lock --workspace "<project-root>"';
const KEEP_LOCKED_BACKEND_SECTIONS = [
  { number: 31, heading: "환경 확인과 설치" },
  { number: 45, heading: "사전 준비와 시나리오 설계" },
  { number: 50, heading: "최종 build와 완료 순서" }
];

function assertStep3BackendLockContract(content) {
  const outputs = extractMarkdownSection(content, "입력과 산출물");
  const execution = extractMarkdownSection(content, "실행");
  const normalized = execution.replace(/\s+/g, " ");
  assert.match(outputs, /^- 산출물: `step_archive\/outputs\/browser-backend\.json`$/m);
  assert.ok(execution.includes(BACKEND_LOCK_COMMAND), "step003 must declare the exact lock command");
  assert.match(normalized, /`--backend` 없이[^]*고정 backend만 사용[^]*다른 backend로 넘어가지 않는다/);
  assert.match(normalized, /두 백엔드 중 하나만 준비[^]*이미 백엔드를 선택했으면 다른 backend의 package나 browser binary를 설치하지 않는다/);
  assert.doesNotMatch(normalized, /독립적으로 실행|다른 backend[^.]{0,60}설치한다/);
  assert.match(extractMarkdownSection(content, "완료 조건"), /^- `browser-backend-lock`: /m);
}

function assertKeepsLockedBackend(content, heading) {
  const section = extractMarkdownSection(content, heading).replace(/\s+/g, " ");
  assert.match(section, /3단계[^]*step_archive\/outputs\/browser-backend\.json[^]*다른 backend의 package나 browser binary를 설치하지 않는다/);
  assert.doesNotMatch(section, /다른 backend[^.]{0,60}설치한다/);
}

test("step003 records the browser backend lock with the exact command and a single-backend rule", async () => {
  const codex = await readFile(join(repoRoot, "codex", "assets", "steps", "step003.md"), "utf8");
  assertStep3BackendLockContract(codex);
  const claude = await readFile(join(repoRoot, "assets", "steps", "step003.md"), "utf8");
  assert.ok(claude.includes(BACKEND_LOCK_COMMAND), "Claude step003 must name the same lock command");
  assert.match(claude, /step_archive\/outputs\/browser-backend\.json/);
  assert.match(claude.replace(/\s+/g, " "), /백엔드는 하나만 준비[^]*다른 백엔드의 package나 browser binary[^]*설치하지 않는다/);
});

test("steps 31, 45 and 50 keep the Step 3 browser backend in both hosts", async () => {
  for (const { number, heading } of KEEP_LOCKED_BACKEND_SECTIONS) {
    const id = `step${String(number).padStart(3, "0")}`;
    const codex = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    assertKeepsLockedBackend(codex, heading);
    const claude = await readFile(join(repoRoot, "assets", "steps", `${id}.md`), "utf8");
    assert.match(claude.replace(/\s+/g, " "), /browser-backend\.json[^]*다른 백엔드의 package나 browser binary[^]*설치하지 않는다/, id);
  }
  const claude31 = await readFile(join(repoRoot, "assets", "steps", "step031.md"), "utf8");
  assert.ok(claude31.includes('node scripts/verify-output.mjs --probe --backend <selected> --lock --workspace "<project-root>"'),
    "Claude step031 must backfill a missing lock from the Step 3 report");
});

test("browser backend lock checks reject removed or inverted clauses", async () => {
  const step3 = await readFile(join(repoRoot, "codex", "assets", "steps", "step003.md"), "utf8");
  const step3Mutations = {
    commandRemoved: step3.replace(BACKEND_LOCK_COMMAND, "node scripts/verify-output.mjs --probe"),
    outputRemoved: step3.replace(/^- 산출물: `step_archive\/outputs\/browser-backend\.json`$/m, "- 산출물: 없음"),
    installAllowed: step3.replace("선택했으면 다른 backend의 package나 browser binary를 설치하지 않는다", "선택했으면 다른 backend의 package나 browser binary를 설치한다"),
    independentInstall: step3.replace("두 백엔드 중 하나만 준비한다", "두 백엔드를 독립적으로 실행한다"),
    fallbackAllowed: step3.replace("다른 backend로 넘어가지 않는다", "다른 backend로 넘어간다"),
    completionRemoved: step3.replace(/^- `browser-backend-lock`: .*$/m, "- 고정 파일은 선택 사항이다.")
  };
  for (const [name, mutation] of Object.entries(step3Mutations)) {
    assert.notEqual(mutation, step3, `step003 mutation did not change content: ${name}`);
    assert.throws(() => assertStep3BackendLockContract(mutation), undefined, `step003 lock mutation escaped: ${name}`);
  }

  for (const { number, heading } of KEEP_LOCKED_BACKEND_SECTIONS) {
    const id = `step${String(number).padStart(3, "0")}`;
    const original = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    const mutations = {
      clauseRemoved: original.replace(/다른 backend의 package나 browser binary를 설치하지 않는다\./, "필요한 도구를 준비한다."),
      installAllowed: original.replace(/다른 backend의 package나 browser binary를 설치하지 않는다/, "다른 backend의 package나 browser binary를 설치한다"),
      lockRemoved: original.replaceAll("`step_archive/outputs/browser-backend.json`", "보고서")
    };
    for (const [name, mutation] of Object.entries(mutations)) {
      assert.notEqual(mutation, original, `${id} mutation did not change content: ${name}`);
      assert.throws(() => assertKeepsLockedBackend(mutation, heading), undefined, `${id} lock mutation escaped: ${name}`);
    }
  }
});
