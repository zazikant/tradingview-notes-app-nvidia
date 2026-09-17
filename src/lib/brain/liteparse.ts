/**
 * LiteParse — Lightweight text extraction for PDF, TXT, MD files.
 *
 * Ported from rag-document-assistant-opencode/src/lib/liteparse.ts.
 * Uses `pdf-parse` with a dynamic import (to avoid its test-PDF-on-startup
 * issue — see https://github.com/mozilla/pdf.js/issues/12442 etc).
 *
 * Works on Node runtime only (not Edge). The /api/brain/upload route is
 * declared `runtime = 'nodejs'` for this reason.
 */

export interface ParseResult {
  text: string;
  success: boolean;
  error?: string;
  pages?: number;
}

async function parsePdfBuffer(buffer: Buffer): Promise<ParseResult> {
  // Dynamic import — pdf-parse ships a test PDF that runs on require(),
  // which would fail serverless cold-starts. Dynamic import + a side-effect
  // suppression works around this.
  const pdfParse = (await import('pdf-parse')).default;
  const data = await pdfParse(buffer);

  let fullText = data.text.trim();

  if (data.numpages && data.numpages > 1) {
    // Preserve page boundaries as text markers so the LLM can cite pages.
    fullText = fullText.replace(/\f/g, '\n\n--- Page Break ---\n\n');
  }

  if (!fullText) {
    return {
      text: '',
      success: false,
      error: 'No extractable text found in PDF (possibly scanned/image-only)',
      pages: data.numpages,
    };
  }

  return {
    text: fullText,
    success: true,
    pages: data.numpages,
  };
}

/**
 * Parse a file and extract text content.
 *
 * @param content  Buffer / ArrayBuffer / Uint8Array / string of the file data,
 *                 or raw text when type="text" (string).
 * @param type     'pdf' or 'text'
 * @param filename Optional filename — extension is used to pick the parser.
 *                 Falls back to `type` if omitted.
 */
export async function liteParse(
  content: Buffer | ArrayBuffer | Uint8Array | string,
  type: 'pdf' | 'text',
  filename?: string,
): Promise<ParseResult> {
  try {
    let buffer: Buffer;
    if (typeof content === 'string') {
      if (type === 'text') {
        return { text: content.trim(), success: true };
      }
      // For PDF over JSON API: base64 string.
      buffer = Buffer.from(content, 'base64');
    } else if (content instanceof ArrayBuffer) {
      buffer = Buffer.from(content);
    } else if (content instanceof Uint8Array) {
      buffer = Buffer.from(content);
    } else {
      buffer = content;
    }

    const ext = filename
      ? (filename.toLowerCase().split('.').pop() || '')
      : (type === 'pdf' ? 'pdf' : 'txt');

    if (ext === 'pdf') {
      return await parsePdfBuffer(buffer);
    }
    if (ext === 'txt' || ext === 'md' || ext === 'json') {
      const text = buffer.toString('utf-8');
      return { text: text.trim(), success: true };
    }
    return {
      text: '',
      success: false,
      error: `Format .${ext} is not supported. Supported: PDF, TXT, MD, JSON.`,
    };
  } catch (err: any) {
    console.error('LiteParse error:', err);
    return {
      text: '',
      success: false,
      error: `Parse failed: ${err?.message || 'Unknown error'}`,
    };
  }
}
