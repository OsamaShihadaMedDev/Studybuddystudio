import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT } from './lib/env.js';
import { validTypeTokens } from './lib/mediaTypeMap.js';

export interface MediaInput {
  buffer: Buffer;
  originalExtension: string;
  context: 'stem' | 'explanation';
  typeToken: string;
  description?: string;
}

export interface ScaffoldInput {
  external_id: string;
  subject: string;
  domain: string;
  topic: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  reasoning_order: '1st' | '2nd' | '3rd';
  competency: string;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  option_e: string;
  correct_option: 'a' | 'b' | 'c' | 'd' | 'e';
  explanation: string;
  teaching_point: string;
  media: MediaInput[];
}

export interface ScaffoldResult {
  folderPath: string;
  relativeFolderPath: string;
  files: string[];
}

interface SubjectConfig {
  name: string;
  prefix: string;
  folder: string;
  domains: Array<{ name: string; abbrev: string }>;
}

interface SubjectsConfig {
  subjects: SubjectConfig[];
}

const VALID_DIFFICULTIES = new Set(['Easy', 'Medium', 'Hard']);
const VALID_REASONING_ORDERS = new Set(['1st', '2nd', '3rd']);
const VALID_OPTIONS = new Set(['a', 'b', 'c', 'd', 'e']);
const VALID_CONTEXTS = new Set(['stem', 'explanation']);

const REQUIRED_STRING_FIELDS: (keyof ScaffoldInput)[] = [
  'external_id', 'subject', 'domain', 'topic', 'competency',
  'question_text', 'option_a', 'option_b', 'option_c', 'option_d',
  'option_e', 'explanation', 'teaching_point',
];

function loadSubjectsConfig(): SubjectsConfig {
  return JSON.parse(
    fs.readFileSync(path.resolve(REPO_ROOT, 'subjects.config.json'), 'utf-8')
  );
}

export function getSubjectsConfig(): SubjectsConfig {
  return loadSubjectsConfig();
}

export function validateScaffoldId(
  external_id: string,
  subject: string,
  domain: string
): { exists: boolean; folderPath: string } {
  const config = loadSubjectsConfig();
  const subjectEntry = config.subjects.find(s => s.name === subject);
  if (!subjectEntry) return { exists: false, folderPath: '' };

  const domainFolder = domain.toLowerCase().replace(/\s+/g, '');
  const folderPath = path.resolve(
    REPO_ROOT,
    subjectEntry.folder,
    domainFolder,
    external_id
  );
  return { exists: fs.existsSync(folderPath), folderPath };
}

export async function scaffoldQuestion(input: ScaffoldInput): Promise<ScaffoldResult> {
  const errors: string[] = [];

  if (!/^[A-Z]{2}-[A-Z]{2,6}-\d{3}$/.test(input.external_id)) {
    errors.push(`Invalid external_id format: "${input.external_id}". Expected: CV-PATH-015`);
  }

  if (!VALID_DIFFICULTIES.has(input.difficulty)) {
    errors.push(`Invalid difficulty: "${input.difficulty}". Must be Easy, Medium, or Hard`);
  }

  if (!VALID_REASONING_ORDERS.has(input.reasoning_order)) {
    errors.push(`Invalid reasoning_order: "${input.reasoning_order}". Must be 1st, 2nd, or 3rd`);
  }

  if (!VALID_OPTIONS.has(input.correct_option)) {
    errors.push(`Invalid correct_option: "${input.correct_option}". Must be a, b, c, d, or e`);
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = input[field];
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`Missing or empty required field: "${field}"`);
    }
  }

  const config = loadSubjectsConfig();
  const subjectEntry = config.subjects.find(s => s.name === input.subject);
  if (!subjectEntry) {
    errors.push(`Subject "${input.subject}" is not defined in subjects.config.json`);
  } else if (!subjectEntry.domains.some(d => d.name === input.domain)) {
    errors.push(
      `Domain "${input.domain}" is not valid for subject "${input.subject}". ` +
      `Valid domains: ${subjectEntry.domains.map(d => d.name).join(', ')}`
    );
  }

  const validTokens = validTypeTokens();
  input.media.forEach((m, i) => {
    if (!validTokens.includes(m.typeToken)) {
      errors.push(`media[${i}]: invalid typeToken "${m.typeToken}". Valid: ${validTokens.join(', ')}`);
    }
    if (!VALID_CONTEXTS.has(m.context)) {
      errors.push(`media[${i}]: invalid context "${m.context}". Must be stem or explanation`);
    }
    if (!m.buffer || m.buffer.length === 0) {
      errors.push(`media[${i}]: buffer is empty`);
    }
  });

  if (errors.length > 0) {
    throw new Error(`Scaffold validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  const domainFolder = input.domain.toLowerCase().replace(/\s+/g, '');
  const folderPath = path.resolve(
    REPO_ROOT,
    subjectEntry!.folder,
    domainFolder,
    input.external_id
  );

  if (fs.existsSync(folderPath)) {
    throw new Error(
      `Folder already exists: ${folderPath}\n` +
      `Use the ingest pipeline to update existing questions.`
    );
  }

  fs.mkdirSync(folderPath, { recursive: true });

  const mediaFilenames: string[] = [];
  const mediaEntries = input.media.map((m) => {
    const filename = `${m.context}.${m.typeToken}${m.originalExtension}`;
    fs.writeFileSync(path.join(folderPath, filename), m.buffer);
    mediaFilenames.push(filename);
    return {
      file: filename,
      description: m.description ?? '',
      source_url: 'studybuddy-internal',
      license: 'proprietary',
      tags: [] as string[],
      caption: null as string | null,
    };
  });

  const questionJson = {
    external_id:     input.external_id,
    subject:         input.subject,
    domain:          input.domain,
    topic:           input.topic,
    difficulty:      input.difficulty,
    reasoning_order: input.reasoning_order,
    competency:      input.competency,
    question_text:   input.question_text,
    option_a:        input.option_a,
    option_b:        input.option_b,
    option_c:        input.option_c,
    option_d:        input.option_d,
    option_e:        input.option_e,
    correct_option:  input.correct_option,
    explanation:     input.explanation,
    teaching_point:  input.teaching_point,
    media:           mediaEntries,
  };

  fs.writeFileSync(
    path.join(folderPath, 'question.json'),
    JSON.stringify(questionJson, null, 2)
  );

  return {
    folderPath,
    relativeFolderPath: path.relative(REPO_ROOT, folderPath),
    files: ['question.json', ...mediaFilenames],
  };
}
