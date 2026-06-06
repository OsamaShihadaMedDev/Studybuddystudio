import express from 'express';
import multer from 'multer';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from './lib/env.js';
import { supabase } from './lib/supabase.js';
import { validTypeTokens, parseMediaFilename } from './lib/mediaTypeMap.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? '';
if (!OPENROUTER_API_KEY) {
  console.warn('  ⚠ OPENROUTER_API_KEY not set — /api/parse-question will not work');
}

const PARSE_SYSTEM_PROMPT = `You are a precise JSON extractor for a medical question bank.
Extract the following fields from the USMLE question text provided and return ONLY valid JSON — no markdown, no code fences, no explanation, no preamble.

Return this exact schema:
{
  "external_id": "string — e.g. CV-HISTO-012, or empty string if not found",
  "subject": "string — infer from context. If not explicitly stated, infer from the domain. For any cardiology/cardiac/ECG/vascular topic, use 'Cardiovascular'. For renal topics use 'Renal'. For GI topics use 'Gastrointestinal'. Default to 'Cardiovascular' if unclear.",
  "domain": "string — e.g. Histopathology, Pathology, Physiology, Pharmacology, Anatomy, Embryology",
  "topic": "string — the Subtopic line",
  "difficulty": "Easy | Medium | Hard",
  "reasoning_order": "1st | 2nd | 3rd",
  "competency": "Foundational Science | Diagnosis – H&P | Diagnosis – Formulating | Management – Pharmacotherapy",
  "question_text": "string — full vignette text including the lead-in question",
  "option_a": "string — text of option A only, no letter prefix",
  "option_b": "string — text of option B only, no letter prefix",
  "option_c": "string — text of option C only, no letter prefix",
  "option_d": "string — text of option D only, no letter prefix",
  "option_e": "string — text of option E only, no letter prefix",
  "correct_option": "a | b | c | d | e — lowercase single letter",
  "explanation": "string — full explanation text including why others are wrong",
  "teaching_point": "string — the HIGH-YIELD TEACHING POINT line only",
  "stem_media_description": "string — a concise one-sentence description of what the stem image should show, inferred from the question context. E.g. 'ECG showing ST depression and tall R waves in V1-V3 consistent with posterior MI'. If no stem image is needed write empty string.",
  "explanation_media_description": "string — a concise one-sentence description of what the explanation image should show, inferred from the question content. E.g. 'Annotated diagram of posterior MI ECG findings with reciprocal changes labeled'. If no explanation image is needed write empty string."
}

Rules:
- Return ONLY the JSON object. No other text.
- If a field cannot be found, use an empty string.
- For correct_option, use only the single lowercase letter.
- Strip any letter prefix from options (e.g. "A." or "A:").
- explanation must include the main explanation AND the why-others-are-wrong section as one combined string.
- Do not invent or hallucinate any content — extract only what is present.`;

app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function getSubjectsConfig() {
  return JSON.parse(
    readFileSync(path.resolve(REPO_ROOT, 'subjects.config.json'), 'utf-8')
  );
}

// ── Password gate ──
app.use((req, res, next) => {
  if (req.path === '/' && req.method === 'GET') return next();

  const authHeader = (req.headers['authorization'] as string | undefined) ?? '';
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const password = decoded.split(':').slice(1).join(':');
    if (password === env.STUDIO_PASSWORD) return next();
  }

  res.status(401).json({ error: 'Unauthorized' });
});

app.get('/', (_req, res) => {
  res.sendFile(path.resolve(__dirname, 'studio.html'));
});

app.get('/api/config', (_req, res) => {
  try {
    const config = getSubjectsConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/next-id', async (req, res) => {
  const { subject, domain } = req.query as Record<string, string>;
  if (!subject || !domain) {
    return res.status(400).json({ error: 'subject and domain are required' });
  }

  try {
    const config = getSubjectsConfig();
    const subjectEntry = config.subjects.find((s: any) => s.name === subject);
    if (!subjectEntry) {
      return res.status(400).json({ error: `Subject "${subject}" not found` });
    }

    const domainEntry = subjectEntry.domains.find((d: any) => d.name === domain);
    if (!domainEntry) {
      return res.status(400).json({ error: `Domain "${domain}" not found for subject "${subject}"` });
    }

    const idPrefix = `${subjectEntry.prefix}-${domainEntry.abbrev}-`;
    const pattern  = `${idPrefix}%`;

    const [{ data: liveRows }, { data: draftRows }] = await Promise.all([
      supabase.from('questions').select('external_id').like('external_id', pattern),
      supabase.from('questions_draft').select('external_id').like('external_id', pattern),
    ]);

    const allIds = [
      ...(liveRows  ?? []).map((r: any) => r.external_id as string),
      ...(draftRows ?? []).map((r: any) => r.external_id as string),
    ];

    let maxNum = 0;
    for (const id of allIds) {
      const numStr = id.slice(idPrefix.length);
      const num = parseInt(numStr, 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    }

    const nextId = `${idPrefix}${String(maxNum + 1).padStart(3, '0')}`;
    res.json({ nextId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/validate-id', async (req, res) => {
  const { id, subject, domain } = req.query as Record<string, string>;
  if (!id || !subject || !domain) {
    return res.status(400).json({ error: 'id, subject, and domain are required' });
  }

  if (!/^[A-Z]{2}-[A-Z]{2,6}-\d{3}$/.test(id)) {
    return res.json({ valid: false, exists: false, message: 'Invalid format. Expected: CV-HISTO-012' });
  }

  try {
    const [{ data: live }, { data: draft }] = await Promise.all([
      supabase.from('questions').select('id').eq('external_id', id).maybeSingle(),
      supabase.from('questions_draft').select('id').eq('external_id', id).maybeSingle(),
    ]);

    const exists = !!(live || draft);
    res.json({
      valid: true,
      exists,
      message: exists ? `ID already exists: ${id}` : `Available: ${id}`,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post(
  '/api/scaffold',
  upload.fields([
    { name: 'stemMedia', maxCount: 5 },
    { name: 'explanationMedia', maxCount: 5 },
  ]),
  async (req, res) => {
    try {
      const body  = req.body as Record<string, string>;
      const files = req.files as Record<string, Express.Multer.File[]>;

      interface MediaInput {
        buffer:      Buffer;
        ext:         string;
        context:     'stem' | 'explanation';
        typeToken:   string;
        description: string;
      }
      const mediaInputs: MediaInput[] = [];

      if (files?.stemMedia) {
        files.stemMedia.forEach((f, i) => {
          mediaInputs.push({
            buffer:      f.buffer,
            ext:         path.extname(f.originalname).toLowerCase() || '.png',
            context:     'stem',
            typeToken:   body[`stemType_${i}`] ?? 'diagram',
            description: (body[`stemMediaDescription_${i}`] ?? '').trim(),
          });
        });
      }
      if (files?.explanationMedia) {
        files.explanationMedia.forEach((f, i) => {
          mediaInputs.push({
            buffer:      f.buffer,
            ext:         path.extname(f.originalname).toLowerCase() || '.png',
            context:     'explanation',
            typeToken:   body[`explanationType_${i}`] ?? 'diagram',
            description: (body[`explanationMediaDescription_${i}`] ?? '').trim(),
          });
        });
      }

      const errors: string[] = [];
      const external_id = (body.external_id ?? '').trim();

      if (!/^[A-Z]{2}-[A-Z]{2,6}-\d{3}$/.test(external_id)) {
        errors.push(`Invalid external_id format: "${external_id}"`);
      }

      const requiredFields = [
        'subject','domain','topic','difficulty','reasoning_order','competency',
        'question_text','option_a','option_b','option_c','option_d','option_e',
        'correct_option','explanation','teaching_point',
      ];
      for (const f of requiredFields) {
        if (!body[f] || body[f].trim() === '') errors.push(`Missing required field: "${f}"`);
      }

      const validTokens = validTypeTokens();
      mediaInputs.forEach((m, i) => {
        if (!validTokens.includes(m.typeToken)) {
          errors.push(`media[${i}]: invalid typeToken "${m.typeToken}"`);
        }
      });

      if (errors.length > 0) {
        return res.status(400).json({ success: false, error: errors.join('; ') });
      }

      const [{ data: existingLive }, { data: existingDraft }] = await Promise.all([
        supabase.from('questions').select('id').eq('external_id', external_id).maybeSingle(),
        supabase.from('questions_draft').select('id').eq('external_id', external_id).maybeSingle(),
      ]);
      if (existingLive || existingDraft) {
        return res.status(400).json({ success: false, error: `external_id "${external_id}" already exists` });
      }

      const stagedMedia: object[] = [];
      for (const m of mediaInputs) {
        const filename    = `${m.context}.${m.typeToken}${m.ext}`;
        const storagePath = `${external_id}/${filename}`;

        const contentType = m.ext === '.png' ? 'image/png'
                          : m.ext === '.svg' ? 'image/svg+xml'
                          : 'image/jpeg';

        const { error: uploadError } = await supabase.storage
          .from('qbank-staging')
          .upload(storagePath, m.buffer, { contentType, upsert: false });

        if (uploadError) {
          throw new Error(`Storage upload failed for "${filename}": ${uploadError.message}`);
        }

        stagedMedia.push({
          storage_path: storagePath,
          type_token:   m.typeToken,
          context:      m.context,
          description:  m.description || `${m.typeToken} image`,
          original_ext: m.ext,
        });
      }

      const { error: insertError } = await supabase
        .from('questions_draft')
        .insert({
          external_id,
          subject:         body.subject,
          domain:          body.domain,
          topic:           body.topic,
          difficulty:      body.difficulty,
          reasoning_order: body.reasoning_order,
          competency:      body.competency,
          question_text:   body.question_text,
          option_a:        body.option_a,
          option_b:        body.option_b,
          option_c:        body.option_c,
          option_d:        body.option_d,
          option_e:        body.option_e,
          correct_option:  body.correct_option,
          explanation:     body.explanation,
          teaching_point:  body.teaching_point,
          staged_media:    stagedMedia,
          status:          'draft',
        });

      if (insertError) {
        throw new Error(`Draft insert failed: ${insertError.message}`);
      }

      res.json({ success: true, external_id, stagedMedia });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  }
);

app.post('/api/ingest', async (req, res) => {
  const { external_id } = req.body as { external_id?: string };

  if (!external_id) {
    return res.status(400).json({ error: 'external_id is required' });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendLine = (msg: string) => res.write(msg + '\n');

  try {
    const { data: draft, error: draftError } = await supabase
      .from('questions_draft')
      .select('*')
      .eq('external_id', external_id)
      .single();

    if (draftError || !draft) throw new Error(`Draft not found for "${external_id}"`);
    if (draft.status === 'pushed') throw new Error(`"${external_id}" has already been pushed`);

    const { data: existing } = await supabase
      .from('questions')
      .select('id')
      .eq('external_id', external_id)
      .maybeSingle();

    if (existing) throw new Error(`"${external_id}" already exists in questions table`);

    const { data: inserted, error: insertError } = await supabase
      .from('questions')
      .insert({
        external_id:     draft.external_id,
        subject:         draft.subject,
        domain:          draft.domain,
        topic:           draft.topic,
        difficulty:      draft.difficulty,
        reasoning_order: draft.reasoning_order,
        competency:      draft.competency,
        question_text:   draft.question_text,
        option_a:        draft.option_a,
        option_b:        draft.option_b,
        option_c:        draft.option_c,
        option_d:        draft.option_d,
        option_e:        draft.option_e,
        correct_option:  draft.correct_option,
        explanation:     draft.explanation,
        teaching_point:  draft.teaching_point,
        is_active:       false,
      })
      .select('id')
      .single();

    if (insertError || !inserted) throw new Error(`Question insert failed: ${insertError?.message}`);
    const questionId = inserted.id;
    sendLine(`✦ Inserted question (${external_id})`);

    const stagedMedia: Array<{
      storage_path: string;
      type_token:   string;
      context:      string;
      description:  string;
      original_ext: string;
    }> = draft.staged_media ?? [];

    for (let i = 0; i < stagedMedia.length; i++) {
      const m = stagedMedia[i];
      const filename = m.storage_path.split('/').pop()!;

      sendLine(`▸ Processing ${filename}…`);

      const { data: fileData, error: downloadError } = await supabase.storage
        .from('qbank-staging')
        .download(m.storage_path);

      if (downloadError || !fileData) {
        throw new Error(`Failed to download "${m.storage_path}": ${downloadError?.message}`);
      }

      const prodPath = `${external_id}/${filename}`;
      const buffer   = Buffer.from(await fileData.arrayBuffer());
      const ext      = m.original_ext || '.png';
      const contentType = ext === '.png' ? 'image/png'
                        : ext === '.svg' ? 'image/svg+xml'
                        : 'image/jpeg';

      const { error: uploadError } = await supabase.storage
        .from('qbank-media')
        .upload(prodPath, buffer, { contentType, upsert: true });

      if (uploadError) {
        throw new Error(`Upload to qbank-media failed for "${filename}": ${uploadError.message}`);
      }

      const { data: urlData } = supabase.storage
        .from('qbank-media')
        .getPublicUrl(prodPath);

      const publicUrl = urlData?.publicUrl;
      if (!publicUrl) throw new Error(`Could not get public URL for "${prodPath}"`);

      const { displayContext, mediaType } = parseMediaFilename(filename);

      const { data: mediaRow, error: mediaError } = await supabase
        .from('media')
        .insert({
          file_url:    publicUrl,
          media_type:  mediaType,
          tags:        [],
          description: m.description || `${m.type_token} image`,
          source_url:  'studybuddy-internal',
          license:     'proprietary',
          attribution: 'StudyBuddy',
        })
        .select('id')
        .single();

      if (mediaError || !mediaRow) {
        throw new Error(`Media insert failed for "${filename}": ${mediaError?.message}`);
      }

      const { error: linkError } = await supabase
        .from('question_media')
        .insert({
          question_id:     questionId,
          media_id:        mediaRow.id,
          display_context: displayContext,
          display_order:   i + 1,
          caption:         null,
        });

      if (linkError) {
        throw new Error(`question_media link failed for "${filename}": ${linkError.message}`);
      }

      sendLine(`✓ Media linked: ${filename} → ${displayContext} (${mediaType})`);
    }

    await supabase
      .from('questions_draft')
      .update({ status: 'pushed' })
      .eq('external_id', external_id);

    sendLine('✓ Ingestion complete.');
    res.end();
  } catch (err) {
    sendLine(`✗ Ingestion failed: ${(err as Error).message}`);
    res.end();
  }
});

app.get('/api/questions', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('questions_draft')
      .select(
        'external_id, subject, domain, topic, difficulty, reasoning_order, ' +
        'question_text, correct_option, option_a, option_b, option_c, option_d, option_e, ' +
        'staged_media, status, created_at'
      )
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    const questions = (data ?? []).map((q: any) => ({
      ...q,
      has_media: Array.isArray(q.staged_media) && q.staged_media.length > 0,
    }));

    res.json(questions);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/parse-question', async (req, res) => {
  const { text } = req.body as { text?: string };

  if (!text || text.trim().length < 50) {
    return res.status(400).json({ error: 'Question text is too short or missing' });
  }

  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY is not configured' });
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'StudyBuddy QBank Studio',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v3.2-exp',
        messages: [
          { role: 'system', content: PARSE_SYSTEM_PROMPT },
          { role: 'user',   content: text },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content ?? '';
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`Model returned invalid JSON: ${cleaned.slice(0, 200)}`);
    }

    const required = [
      'subject', 'domain', 'topic', 'difficulty', 'reasoning_order',
      'competency', 'question_text', 'option_a', 'option_b', 'option_c',
      'option_d', 'option_e', 'correct_option', 'explanation', 'teaching_point',
    ];
    const missing = required.filter(f => !parsed[f] || parsed[f].trim() === '');
    if (missing.length > 0) {
      return res.status(422).json({
        error: `Parse incomplete — missing fields: ${missing.join(', ')}`,
        partial: parsed,
      });
    }

    res.json({ success: true, parsed });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`\n── StudyBuddy QBank Studio ──`);
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`   Stop:   Ctrl+C\n`);
});
