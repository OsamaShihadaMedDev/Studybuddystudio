import express from 'express';
import multer from 'multer';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './lib/env.js';
import {
  scaffoldQuestion,
  validateScaffoldId,
  getSubjectsConfig,
  ScaffoldInput,
  MediaInput,
} from './scaffoldQuestion.js';
import { ingestFolder } from './ingestQuestions.js';

const app = express();
const PORT = 3000;

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

app.get('/api/validate-id', (req, res) => {
  const { id, subject, domain } = req.query as Record<string, string>;

  if (!id || !subject || !domain) {
    return res.status(400).json({ error: 'id, subject, and domain are required' });
  }

  if (!/^[A-Z]{2}-[A-Z]{2,6}-\d{3}$/.test(id)) {
    return res.json({
      valid: false,
      exists: false,
      message: 'Invalid format. Expected: CV-HISTO-012',
    });
  }

  const { exists, folderPath } = validateScaffoldId(id, subject, domain);
  res.json({
    valid: true,
    exists,
    message: exists
      ? `Folder already exists: ${path.relative(REPO_ROOT, folderPath)}`
      : `Available: ${path.relative(REPO_ROOT, folderPath)}`,
  });
});

app.post(
  '/api/scaffold',
  upload.fields([
    { name: 'stemMedia', maxCount: 5 },
    { name: 'explanationMedia', maxCount: 5 },
  ]),
  async (req, res) => {
    try {
      const body = req.body as Record<string, string>;
      const files = req.files as Record<string, Express.Multer.File[]>;

      const mediaInputs: MediaInput[] = [];

      if (files?.stemMedia) {
        for (const f of files.stemMedia) {
          const i = mediaInputs.filter(m => m.context === 'stem').length;
          const typeKey = `stemType_${i}`;
          const descKey = `stemMediaDescription_${i}`;
          mediaInputs.push({
            buffer: f.buffer,
            originalExtension: path.extname(f.originalname).toLowerCase() || '.png',
            context: 'stem',
            typeToken: body[typeKey] ?? body.stemType ?? 'diagram',
            description: ((body[descKey] ?? body.stemMediaDescription) || '').trim(),
          });
        }
      }

      if (files?.explanationMedia) {
        for (const f of files.explanationMedia) {
          const i = mediaInputs.filter(m => m.context === 'explanation').length;
          const typeKey = `explanationType_${i}`;
          const descKey = `explanationMediaDescription_${i}`;
          mediaInputs.push({
            buffer: f.buffer,
            originalExtension: path.extname(f.originalname).toLowerCase() || '.png',
            context: 'explanation',
            typeToken: body[typeKey] ?? body.explanationType ?? 'diagram',
            description: ((body[descKey] ?? body.explanationMediaDescription) || '').trim(),
          });
        }
      }

      const input: ScaffoldInput = {
        external_id:     body.external_id,
        subject:         body.subject,
        domain:          body.domain,
        topic:           body.topic,
        difficulty:      body.difficulty as ScaffoldInput['difficulty'],
        reasoning_order: body.reasoning_order as ScaffoldInput['reasoning_order'],
        competency:      body.competency,
        question_text:   body.question_text,
        option_a:        body.option_a,
        option_b:        body.option_b,
        option_c:        body.option_c,
        option_d:        body.option_d,
        option_e:        body.option_e,
        correct_option:  body.correct_option as ScaffoldInput['correct_option'],
        explanation:     body.explanation,
        teaching_point:  body.teaching_point,
        media:           mediaInputs,
      };

      const result = await scaffoldQuestion(input);

      res.json({
        success: true,
        folderPath: result.folderPath,
        relativeFolderPath: result.relativeFolderPath,
        files: result.files,
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        error: (err as Error).message,
      });
    }
  }
);

app.post('/api/ingest', async (req, res) => {
  const { folderPath } = req.body as { folderPath?: string };

  if (!folderPath || !fs.existsSync(folderPath)) {
    return res.status(400).json({ error: 'Valid folderPath is required' });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendLine = (msg: string) => {
    res.write(msg + '\n');
  };

  try {
    await ingestFolder(folderPath, false, sendLine);
    sendLine('✓ Ingestion complete.');
    res.end();
  } catch (err) {
    sendLine(`✗ Ingestion failed: ${(err as Error).message}`);
    res.end();
  }
});

app.get('/api/questions', (_req, res) => {
  try {
    const config = getSubjectsConfig();
    const questions: object[] = [];

    const findJsonFiles = (dir: string): string[] => {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...findJsonFiles(fullPath));
        } else if (entry.name === 'question.json') {
          results.push(fullPath);
        }
      }
      return results;
    };

    for (const subject of config.subjects) {
      const subjectPath = path.resolve(REPO_ROOT, subject.folder);
      if (!fs.existsSync(subjectPath)) continue;

      for (const jsonPath of findJsonFiles(subjectPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          questions.push({
            external_id:     data.external_id,
            subject:         data.subject,
            domain:          data.domain,
            topic:           data.topic,
            difficulty:      data.difficulty,
            reasoning_order: data.reasoning_order,
            question_text:   data.question_text,
            correct_option:  data.correct_option,
            option_a:        data.option_a,
            option_b:        data.option_b,
            option_c:        data.option_c,
            option_d:        data.option_d,
            option_e:        data.option_e,
            has_media:       Array.isArray(data.media) && data.media.length > 0,
            folder:          path.relative(REPO_ROOT, path.dirname(jsonPath)),
          });
        } catch {
          // skip malformed JSON
        }
      }
    }

    questions.sort((a: any, b: any) =>
      b.external_id.localeCompare(a.external_id)
    );

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

app.get('/api/next-id', (req, res) => {
  const { subject, domain } = req.query as Record<string, string>;

  if (!subject || !domain) {
    return res.status(400).json({ error: 'subject and domain are required' });
  }

  try {
    const config = getSubjectsConfig();
    const subjectEntry = config.subjects.find(s => s.name === subject);

    if (!subjectEntry) {
      return res.status(400).json({ error: `Subject "${subject}" not found` });
    }

    const domainEntry = subjectEntry.domains.find(d => d.name === domain);
    if (!domainEntry) {
      return res.status(400).json({ error: `Domain "${domain}" not found for subject "${subject}"` });
    }

    const prefix = subjectEntry.prefix;
    const abbrev = domainEntry.abbrev;
    const idPrefix = `${prefix}-${abbrev}-`;

    const subjectFolderPath = path.resolve(REPO_ROOT, subjectEntry.folder);
    let maxNum = 0;

    if (fs.existsSync(subjectFolderPath)) {
      const findMatchingFolders = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith(idPrefix)) {
            const numStr = entry.name.slice(idPrefix.length);
            const num = parseInt(numStr, 10);
            if (!isNaN(num) && num > maxNum) maxNum = num;
          } else {
            findMatchingFolders(path.join(dir, entry.name));
          }
        }
      };
      findMatchingFolders(subjectFolderPath);
    }

    const nextNum = String(maxNum + 1).padStart(3, '0');
    const nextId = `${idPrefix}${nextNum}`;

    res.json({ nextId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`\n── StudyBuddy QBank Studio ──`);
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`   Stop:   Ctrl+C\n`);
});
