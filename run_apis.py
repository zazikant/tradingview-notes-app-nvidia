import json
import requests
import sys

# ======== CIRCULAR DEPENDENCIES API ========
CD_URL = "https://ax-opencode-translator.vercel.app/api/translate"

NOTES = """
PROBLEM: Ticker field in Editor.tsx uses HTML <input> which is single-line only. 
User cannot type spaces or newlines in ticker field.

CURRENT CODE ANALYSIS:
1. Editor.tsx line 80-92: <input className="editor-ticker-input"> — single line, no space/newline
2. Editor.tsx onChange: e.target.value.toUpperCase() — auto-uppercasing works but input prevents multi-line
3. Editor.tsx onKeyDown: e.stopPropagation() — stops propagation but doesn't help with input limitation
4. page.tsx: global keyboard handler with Ctrl+S, Ctrl+N, Escape — may interfere if not handled
5. useNotes.ts updateCurrentNote: ticker: updates.ticker.toUpperCase().trim() — .trim() removes spaces
6. useNotes.ts copyNote: uses note.ticker directly — no issue
7. utils.ts exportNotesToCSV: uses note.ticker — no issue  
8. utils.ts parseNotesFromCSV: ticker = parts[0].trim().toUpperCase() — trims whitespace
9. NotesPanel.tsx NoteCard: displays note.ticker in single line — needs to handle multi-line
10. supabase.ts: stores ticker as-is — no constraint
11. globals.css: .editor-ticker-input styled for single line (width: 100%, specific font sizing)
12. globals.css: .note-ticker styled with word-break: break-word — already handles long text

REQUIRED CHANGES:
- Change <input> to <textarea> in Editor.tsx for multi-line support
- Remove .toUpperCase() auto-conversion (or make it optional since multi-line titles shouldn't be all-caps)
- Remove .trim() from updateCurrentNote to preserve spaces
- Add rows={1} with auto-grow behavior to textarea
- Update CSS for .editor-ticker-input to support textarea
- Update NoteCard in NotesPanel.tsx to display multi-line ticker properly
- Adjust CSV export/import to handle multi-line tickers (quote properly)

CIRCULAR DEPENDENCIES TO REMOVE:
1. Ticker field assumes single-line → input element enforces it → CSS designed for input → can't add newlines
2. Auto-uppercase assumption → .toUpperCase() on every change → multi-line looks weird in all-caps
3. .trim() in updateCurrentNote strips intentional spaces → user frustrated
4. CSV format assumes single-line ticker → export doesn't quote ticker → import breaks on multi-line
"""

cd_payload = {
    "text": f"Convert telegraphic notes into a structured, circular dependicies removal. Preserve Facts, headings, subheadings, bullet points. Add Argumentative connectives and logical flow. Style polished.\n\nInput:\n\n{NOTES}",
    "sourceLanguage": "en",
    "targetLanguage": "en",
    "fast": True
}

print("=" * 60)
print("RUNNING: Circular Dependencies API")
print("=" * 60)

try:
    cd_resp = requests.post(CD_URL, json=cd_payload, headers={"Content-Type": "application/json"}, timeout=120)
    cd_resp.raise_for_status()
    cd_data = cd_resp.json()
    cd_result = cd_data.get("translatedText", str(cd_data))
    print(cd_result[:3000])
    
    with open("/home/z/my-project/download/circular_deps_analysis.txt", "w", encoding="utf-8") as f:
        f.write(cd_result)
    print("\n\nSaved to circular_deps_analysis.txt")
except Exception as e:
    print(f"Circular Dependencies API error: {e}")
    cd_result = None

# ======== ATOMIC GRAPH API ========
AG_URL = "https://atomic-graph.vercel.app/api/nvidia"
AG_KEY = "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"
MODEL = "openai/gpt-oss-120b"

SYSTEM_PROMPT = """You are a semantic reasoning engine that builds knowledge graphs from raw thinking.
You do NOT merely reformat or summarise — you REASON through the semantic space of ideas.
You surface implicit structure the writer already knows but didn't articulate.
You infer missing concepts, bridge gaps, and make hidden relationships explicit.
QUALITY MATTERS: you preserve the writer's original meaning faithfully.
You do NOT over-process, hallucinate, or add unnecessary complexity.

CRITICAL OUTPUT RULES:
- Always respond with valid JSON only. No markdown, no explanation, no code fences.
- Every response must be a single valid JSON object parseable by JSON.parse().
- Be CONCISE in summaries: 1-2 short sentences max per node.
- Keep titles short: 2-5 words.
- Use minimal tags: 1-3 per node.
- Avoid overly verbose edge labels — use 1-3 word specific verbs."""

print("\n\n" + "=" * 60)
print("RUNNING: Atomic Graph API — EXTRACT")
print("=" * 60)

extract_prompt = f"""Extract atomic concepts from these notes about a ticker field problem and its fix. Each concept = ONE idea only.

Rules:
- Identify explicit AND implicit concepts (what's assumed but not named)
- Infer "glue" concepts that connect ideas but are left unsaid
- Title: 2-5 words. Summary: 1-2 SHORT sentences explaining WHY it matters.
- Preserve the writer's intent. Minor wording differences are NOT new concepts.
- Tags: 1-3 descriptive tags for grouping.
- Be CONCISE — do NOT repeat input text verbatim.

Return JSON: {{ "nodes": [{{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }}] }}

Raw notes:
{NOTES}"""

try:
    ag_payload = {
        "apiKey": AG_KEY,
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": extract_prompt}
        ]
    }
    ag_resp = requests.post(AG_URL, json=ag_payload, headers={"Content-Type": "application/json"}, timeout=120)
    ag_resp.raise_for_status()
    ag_data = ag_resp.json()
    content = ag_data.get("choices", [{}])[0].get("message", {}).get("content", "")
    
    # Clean markdown fences
    cleaned = content.strip()
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        cleaned = "\n".join(lines)
    
    nodes_result = json.loads(cleaned)
    nodes = nodes_result.get("nodes", [])
    print(f"Extracted {len(nodes)} nodes")
    for n in nodes:
        print(f"  {n['id']}: {n['title']} [{', '.join(n.get('tags', []))}]")
    
    # LINK step
    print("\n" + "=" * 60)
    print("RUNNING: Atomic Graph API — LINK")
    print("=" * 60)
    
    node_list = ", ".join([f"{n['id']}: {n['title']}" for n in nodes])
    link_prompt = f"""Map relationships between these atomic concepts about a ticker field fix.

Find both direct and implicit relationships:
- Direct: A enables B, A requires B, A blocks B, A is modified by B
- Implicit: A and B connected through unstated C
- Causal: A leads to B which blocks C

Edge labels: use SPECIFIC verbs ("blocks", "enables", "requires", "constrains", "modifies"), NOT generic "related to".
Keep labels to 1-3 words.

Strength (0.0-1.0):
- 0.9+: definitionally true
- 0.7-0.9: strongly implied
- 0.4-0.7: inferred bridge
- 0.0-0.4: speculative

Only create edges for REAL relationships. Do NOT fabricate connections.
Return ONLY edges — do NOT repeat nodes.

Return JSON: {{ "edges": [{{ "source": "nodeId", "target": "nodeId", "label": "verb", "strength": 0.8 }}] }}

Nodes (id: title):
{node_list}"""
    
    ag_payload2 = {
        "apiKey": AG_KEY,
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": link_prompt}
        ]
    }
    ag_resp2 = requests.post(AG_URL, json=ag_payload2, headers={"Content-Type": "application/json"}, timeout=120)
    ag_resp2.raise_for_status()
    ag_data2 = ag_resp2.json()
    content2 = ag_data2.get("choices", [{}])[0].get("message", {}).get("content", "")
    
    cleaned2 = content2.strip()
    if cleaned2.startswith("```"):
        lines2 = cleaned2.split("\n")
        lines2 = [l for l in lines2 if not l.strip().startswith("```")]
        cleaned2 = "\n".join(lines2)
    
    edges_result = json.loads(cleaned2)
    edges = edges_result.get("edges", [])
    print(f"Created {len(edges)} edges")
    for e in edges:
        print(f"  {e['source']} --[{e['label']} ({e['strength']})]--> {e['target']}")
    
    # Save final
    final = {"nodes": nodes, "edges": edges}
    with open("/home/z/my-project/download/ticker_fix_atomic_graph.json", "w", encoding="utf-8") as f:
        json.dump(final, f, indent=2, ensure_ascii=False)
    print("\nSaved to ticker_fix_atomic_graph.json")

except Exception as e:
    print(f"Atomic Graph API error: {e}")
    import traceback
    traceback.print_exc()

print("\n\nDONE — Both APIs completed")
