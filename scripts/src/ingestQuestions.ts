import { supabase } from './lib/supabase.js';
import { parseMediaFilename, License } from './lib/mediaTypeMap.js';
import { REPO_ROOT } from './lib/env.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MediaEntry {
  file: string;
  description: string;
  source_url: string;
  license: License;
  tags: string[];
  caption?: string | null;
}

interface QuestionJSON {
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
  media?: MediaEntry[];
}

interface FailedIngestion {
  folder: string;
  error: string;
  timestamp: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_BUCKET = 'qbank-media';
const FAILED_LOG_PATH = path.resolve(REPO_ROOT, 'scripts', 'src', 'failed_ingestions.json');

const VALID_DIFFICULTIES = new Set(['Easy', 'Medium', 'Hard']);
const VALID_REASONING_ORDERS = new Set(['1st', '2nd', '3rd']);
const VALID_OPTIONS = new Set(['a', 'b', 'c', 'd', 'e']);
const VALID_LICENSES = new Set(['CC0', 'CC-BY', 'public_domain', 'ODC-BY', 'proprietary']);

// ─── Validation ───────────────────────────────────────────────────────────────

function validateQuestionJSON(data: unknown, folderPath: string): QuestionJSON {
  const q = data as Record<string, unknown>;
  const errors: string[] = [];

  const requiredStrings = [
    'external_id', 'subject', 'domain', 'topic', 'competency',
    'question_text', 'option_a', 'option_b', 'option_c', 'option_d',
    'option_e', 'correct_option', 'explanation', 'teaching_point',
    'difficulty', 'reasoning_order',
  ];

  for (const field of requiredStrings) {
    if (!q[field] || typeof q[field] !== 'string' || (q[field] as string).trim() === '') {
      errors.push(`Missing or empty required field: "${field}"`);
    }
  }

  if (typeof q.external_id === 'string' && !/^[A-Z]{2}-[A-Z]{2,6}-\d{3}$/.test(q.external_id)) {
    errors.push(`Invalid external_id format: "${q.external_id}". Expected format: CV-PATH-015`);
  }

  if (typeof q.difficulty === 'string' && !VALID_DIFFICULTIES.has(q.difficulty)) {
    errors.push(`Invalid difficulty: "${q.difficulty}". Must be Easy, Medium, or Hard`);
  }

  if (typeof q.reasoning_order === 'string' && !VALID_REASONING_ORDERS.has(q.reasoning_order)) {
    errors.push(`Invalid reasoning_order: "${q.reasoning_order}". Must be 1st, 2nd, or 3rd`);
  }

  if (typeof q.correct_option === 'string' && !VALID_OPTIONS.has(q.correct_option)) {
    errors.push(`Invalid correct_option: "${q.correct_option}". Must be a, b, c, d, or e`);
  }

  if (q.media !== undefined) {
    if (!Array.isArray(q.media)) {
      errors.push('"media" must be an array');
    } else {
      (q.media as unknown[]).forEach((entry, i) => {
        const m = entry as Record<string, unknown>;

        if (!m.file || typeof m.file !== 'string') {
          errors.push(`media[${i}]: missing "file"`);
        } else {
          const filePath = path.join(folderPath, m.file as string);
          if (!fs.existsSync(filePath)) {
            errors.push(`media[${i}]: file "${m.file}" not found in folder`);
          }
          try {
            parseMediaFilename(m.file as string);
          } catch (err) {
            errors.push(`media[${i}]: ${(err as Error).message}`);
          }
        }

        if (!m.description || typeof m.description !== 'string') {
          errors.push(`media[${i}]: missing "description"`);
        }
        if (!m.source_url || typeof m.source_url !== 'string') {
          errors.push(`media[${i}]: missing "source_url"`);
        }
        if (!m.license || typeof m.license !== 'string') {
          errors.push(`media[${i}]: missing "license"`);
        } else if (!VALID_LICENSES.has(m.license as string)) {
          errors.push(`media[${i}]: invalid license "${m.license}". Must be one of: ${[...VALID_LICENSES].join(', ')}`);
        }
        if (!Array.isArray(m.tags)) {
          errors.push(`media[${i}]: "tags" must be an array`);
        }
      });
    }
  }

  if (errors.length > 0) {
    throw new Error(`Validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  return q as unknown as QuestionJSON;
}

// ─── Media upload ─────────────────────────────────────────────────────────────

async function uploadMedia(
  localFilePath: string,
  storagePath: string,
): Promise<string> {
  const fileBuffer = fs.readFileSync(localFilePath);

  console.log(`    DEBUG: bucket = ${STORAGE_BUCKET}`);
  console.log(`    DEBUG: storagePath = ${storagePath}`);
  console.log(`    DEBUG: fileSize = ${fileBuffer.length} bytes`);
  console.log(`    DEBUG: SUPABASE_URL = ${process.env.SUPABASE_URL}`);

  const ext = path.extname(localFilePath).toLowerCase();
  const contentTypeMap: Record<string, string> = {
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg':  'image/svg+xml',
  };
  const contentType = contentTypeMap[ext] ?? 'application/octet-stream';

  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType,
      upsert: true,
    });

  console.log(`    DEBUG: upload data = ${JSON.stringify(data)}`);
  console.log(`    DEBUG: upload error = ${JSON.stringify(error)}`);

  if (error) {
    throw new Error(`Storage upload failed for "${storagePath}": ${error.message} | cause: ${JSON.stringify(error)}`);
  }

  const { data: urlData } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(storagePath);

  if (!urlData?.publicUrl) {
    throw new Error(`Could not get public URL for "${storagePath}"`);
  }

  return urlData.publicUrl;
}

// ─── Core ingestion ───────────────────────────────────────────────────────────

export async function ingestFolder(
  folderPath: string,
  skipExisting: boolean = false,
  log: (msg: string) => void = console.log
): Promise<void> {
  const jsonPath = path.join(folderPath, 'question.json');

  if (!fs.existsSync(jsonPath)) {
    throw new Error(`No question.json found in ${folderPath}`);
  }

  let rawData: unknown;
  try {
    rawData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  } catch {
    throw new Error('Failed to parse question.json: invalid JSON');
  }

  const q = validateQuestionJSON(rawData, folderPath);

  // Check if question already exists
  const { data: existing, error: lookupError } = await supabase
    .from('questions')
    .select('id')
    .eq('external_id', q.external_id)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`DB lookup failed: ${lookupError.message}`);
  }

  if (existing && skipExisting) {
    const folderName = path.basename(folderPath);
    log(`  ⏭ Skipped: ${folderName} (already ingested)`);
    return;
  }

  const isUpdate = !!existing;
  let questionId: string;

  const questionRow = {
    external_id:     q.external_id,
    subject:         q.subject,
    domain:          q.domain,
    topic:           q.topic,
    difficulty:      q.difficulty,
    reasoning_order: q.reasoning_order,
    competency:      q.competency,
    question_text:   q.question_text,
    option_a:        q.option_a,
    option_b:        q.option_b,
    option_c:        q.option_c,
    option_d:        q.option_d,
    option_e:        q.option_e,
    correct_option:  q.correct_option,
    explanation:     q.explanation,
    teaching_point:  q.teaching_point,
    is_active:       false,
  };

  if (isUpdate) {
    const { error: updateError } = await supabase
      .from('questions')
      .update(questionRow)
      .eq('external_id', q.external_id);

    if (updateError) {
      throw new Error(`Question update failed: ${updateError.message}`);
    }

    questionId = existing.id;
    log(`  ↻ Updated existing question (${q.external_id})`);

    // Clear old media links so we recreate them cleanly
    const { error: deleteLinksError } = await supabase
      .from('question_media')
      .delete()
      .eq('question_id', questionId);

    if (deleteLinksError) {
      throw new Error(`Failed to clear old media links: ${deleteLinksError.message}`);
    }

  } else {
    const { data: inserted, error: insertError } = await supabase
      .from('questions')
      .insert(questionRow)
      .select('id')
      .single();

    if (insertError || !inserted) {
      throw new Error(`Question insert failed: ${insertError?.message}`);
    }

    questionId = inserted.id;
    log(`  ✦ Inserted new question (${q.external_id})`);
  }

  // Process media
  const mediaEntries = q.media ?? [];

  for (let i = 0; i < mediaEntries.length; i++) {
    const entry = mediaEntries[i];
    const { displayContext, mediaType } = parseMediaFilename(entry.file);
    const localFilePath = path.join(folderPath, entry.file);
    const storagePath = `${q.external_id}/${entry.file}`;

    log(`  ↑ Uploading ${entry.file}...`);
    const publicUrl = await uploadMedia(localFilePath, storagePath);

    const { data: mediaRow, error: mediaError } = await supabase
      .from('media')
      .insert({
        file_url:    publicUrl,
        media_type:  mediaType,
        tags:        entry.tags,
        description: entry.description,
        source_url:  entry.source_url,
        license:     entry.license,
        attribution: entry.license === 'proprietary' ? 'StudyBuddy' : null,
      })
      .select('id')
      .single();

    if (mediaError || !mediaRow) {
      throw new Error(`Media insert failed for "${entry.file}": ${mediaError?.message}`);
    }

    const { error: linkError } = await supabase
      .from('question_media')
      .insert({
        question_id:     questionId,
        media_id:        mediaRow.id,
        display_context: displayContext,
        display_order:   i + 1,
        caption:         entry.caption ?? null,
      });

    if (linkError) {
      throw new Error(`question_media link failed for "${entry.file}": ${linkError.message}`);
    }

    log(`  ✓ Media linked: ${entry.file} → ${displayContext} (${mediaType})`);
  }
}

// ─── Folder discovery ─────────────────────────────────────────────────────────

function findFolderByName(root: string, name: string): string | null {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.name === name) return fullPath;
    const found = findFolderByName(fullPath, name);
    if (found) return found;
  }
  return null;
}

function findAllQuestionFolders(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dir, entry.name);
    if (fs.existsSync(path.join(fullPath, 'question.json'))) {
      results.push(fullPath);
    } else {
      results.push(...findAllQuestionFolders(fullPath));
    }
  }
  return results.sort();
}

function findQuestionFolders(targetFolder?: string): string[] {
  if (targetFolder) {
    const found = findFolderByName(REPO_ROOT, targetFolder);
    if (!found) throw new Error(`Folder "${targetFolder}" not found under ${REPO_ROOT}`);
    return [found];
  }
  return findAllQuestionFolders(REPO_ROOT);
}

// ─── Failure logger ───────────────────────────────────────────────────────────

function logFailure(folder: string, error: string): void {
  let existing: FailedIngestion[] = [];
  if (fs.existsSync(FAILED_LOG_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(FAILED_LOG_PATH, 'utf-8'));
    } catch {
      existing = [];
    }
  }
  existing.push({ folder, error, timestamp: new Date().toISOString() });
  fs.writeFileSync(FAILED_LOG_PATH, JSON.stringify(existing, null, 2));
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n── StudyBuddy QBank Ingestion Pipeline ──\n');

  const args = process.argv.slice(2);
  const folderArgIndex = args.indexOf('--folder');
  const targetFolder = folderArgIndex !== -1 ? args[folderArgIndex + 1] : undefined;
  const skipExisting = args.includes('--skip-existing');

  let folders: string[];
  try {
    folders = findQuestionFolders(targetFolder);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }

  if (folders.length === 0) {
    console.log('No question folders found. Nothing to ingest.');
    return;
  }

  console.log(`Found ${folders.length} question folder(s) to process.\n`);

  let successCount = 0;
  let failCount = 0;

  for (const folderPath of folders) {
    const folderName = path.basename(folderPath);
    console.log(`▶ Processing: ${folderName}`);

    try {
      await ingestFolder(folderPath, skipExisting);
      console.log(`✓ ${folderName} — ingested (is_active = false)\n`);
      successCount++;
    } catch (err) {
      const message = (err as Error).message;
      console.error(`✗ ${folderName} — FAILED: ${message}\n`);
      logFailure(folderName, message);
      failCount++;
    }
  }

  console.log('── Ingestion Complete ──');
  console.log(`✓ Success: ${successCount}`);
  if (failCount > 0) {
    console.log(`✗ Failed:  ${failCount} (see scripts/src/failed_ingestions.json)`);
  }
  console.log('\nReview in Supabase then flip is_active = true to publish.\n');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}