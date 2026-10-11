const FIELDS = ["topic", "audience", "interactive", "real_world_apps", "constraints", "decisions"];
const DEFAULTS = {
  audience: "기본값(사용자 미지정): 주제에 관심이 있는 초보 사용자를 전문 대상이 명시되면 그 대상을 우선한다.",
  interactive: "기본값(사용자 미지정): 직접 조작하고 결과를 확인할 수 있는 상호작용을 제공한다. 전문에 명시된 게임·도구·학습 활동을 기준으로 설계한다.",
  real_world_apps: "기본값(사용자 미지정): 전문의 명시 제공 자료와 현재 검증된 출력을 근거로 삼는다. 미확인 사실은 미확인으로 남기며 필수 계약 누락을 기록한다.",
  constraints: "기본값(사용자 미지정): 전문에 명시된 구현·표현 제약을 우선한다. 추가 제약이 없으면 Harness14의 단일 HTML 산출물과 반응형·접근성 계약을 적용한다.",
  decisions: "기본 결정: 전문을 보존하고 미지정 항목에만 기본값을 적용한다. 내부 설계는 주제와 명시된 제약 안에서 결정한다. 추가 사용자 결정을 가정하지 않는다."
};

function fenceDelimiter(line) {
  return /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
}

function walkOutsideFences(topic, visit) {
  let fence = null;
  for (const line of topic.split(/\r?\n/)) {
    const delimiter = fenceDelimiter(line);
    if (fence) {
      const closing = Boolean(delimiter && delimiter[1][0] === fence[0]
        && delimiter[1].length >= fence.length && !delimiter[2].trim());
      visit(line, true, closing);
      if (closing) fence = null;
      continue;
    }
    if (delimiter) {
      fence = delimiter[1];
      visit(line, true, true);
      continue;
    }
    visit(line, false, false);
  }
}

function markdownHeading(line) {
  const match = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
  if (!match) return null;
  return match[1].replace(/[ \t]+#+[ \t]*$/, "").replace(/^`|`$/g, "").trim();
}

function yamlEntry(line) {
  const match = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_-]*)):[ \t]*(.*)$/.exec(line);
  return match ? { key: match[1] ?? match[2] ?? match[3], value: match[4] } : null;
}

function stripYamlComment(value) {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (doubleQuoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (singleQuoted) {
      if (character === "'" && value[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
    } else if (character === "'") {
      singleQuoted = true;
    } else if (character === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function isEmptyScalar(value) {
  const trimmed = value.trim();
  return !trimmed
    || /^(?:null|~|\[\]|\{\})$/i.test(trimmed)
    || /^"[ \t]*"$/.test(trimmed)
    || /^'[ \t]*'$/.test(trimmed);
}

function addValue(values, field, value) {
  if (!field || isEmptyScalar(value)) return;
  values.set(field, values.has(field) ? `${values.get(field)}\n${value}` : value);
}

function fencedLiteral(value) {
  let fenceLength = 3;
  for (const match of value.matchAll(/~+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = "~".repeat(fenceLength);
  return `${fence}text\n${value}${value.endsWith("\n") ? "" : "\n"}${fence}`;
}

function readMarkdownFields(topic) {
  const values = new Map();
  let current = null;
  let lines = [];
  const flush = () => {
    addValue(values, current, lines.join("\n").trim());
    current = null;
    lines = [];
  };

  walkOutsideFences(topic, (line, inFence, fenceBoundary) => {
    if (!inFence) {
      const heading = markdownHeading(line);
      if (heading !== null) {
        flush();
        if (FIELDS.includes(heading)) current = heading;
        return;
      }
    }
    if (current && !fenceBoundary) lines.push(line);
  });
  flush();
  return values;
}

function isBlockIndicator(value) {
  return /^[|>](?:[+-]?[1-9]?|[1-9]?[+-]?)[ \t]*(?:#.*)?$/.test(value);
}

function readYamlFields(topic) {
  const values = new Map();
  let current = null;
  let lines = [];
  let block = false;
  const flush = () => {
    const value = block
      ? lines.join("\n").trim()
      : lines.map(stripYamlComment).join("\n").trim();
    addValue(values, current, value);
    current = null;
    lines = [];
    block = false;
  };

  walkOutsideFences(topic, (line, inFence) => {
    if (!inFence) {
      const entry = yamlEntry(line);
      if (entry || line === "---" || line === "...") {
        flush();
        if (entry && FIELDS.includes(entry.key)) {
          current = entry.key;
          block = isBlockIndicator(entry.value);
          if (entry.value && !block) lines.push(entry.value);
        }
        return;
      }
    }
    if (current) lines.push(line);
  });
  flush();
  return values;
}

function readFields(topic) {
  let markdown = false;
  walkOutsideFences(topic, (line, inFence) => {
    if (!inFence && FIELDS.includes(markdownHeading(line))) markdown = true;
  });
  return markdown ? readMarkdownFields(topic) : readYamlFields(topic);
}

export function hasCompleteTopicContract(topic) {
  if (typeof topic !== "string") return false;
  const fields = readFields(topic);
  return FIELDS.every(field => fields.has(field));
}

export function prepareTopicContract(topic) {
  const fields = readFields(topic);
  if (FIELDS.every(field => fields.has(field))) return topic;

  const firstLine = topic.trim().split(/\r?\n/, 1)[0].replace(/^#{1,6}[ \t]+/, "");
  const title = /^(?:- )?[a-z_]+:|^---$/.test(firstLine)
    ? "기본 주제: 아래 요청 전문의 설명을 따름"
    : firstLine;
  const sections = FIELDS.map(field => {
    const value = fields.get(field) ?? (field === "topic" ? title : DEFAULTS[field]);
    return `## ${field}\n\n${fencedLiteral(value)}`;
  });
  const missing = FIELDS.filter(field => !fields.has(field));
  return [
    "# Harness14 topic contract",
    ...sections,
    `## initialization_notes\n\n기본값으로 보완한 항목: ${missing.join(", ") || "없음"}. 원문의 명시 조건이 기본값보다 우선한다.`,
    `## original_request\n\n${fencedLiteral(topic)}`
  ].join("\n\n") + "\n";
}
