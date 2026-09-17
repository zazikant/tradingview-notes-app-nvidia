import json
import requests
import sys

API_URL = "https://atomic-graph.vercel.app/api/nvidia"
API_KEY = "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"
MODEL = "openai/gpt-oss-120b"

SYSTEM_PROMPT = """You are a semantic reasoning engine that builds knowledge graphs from raw thinking.
You do NOT merely reformat or summarise — you REASON through the semantic space of ideas.
You surface implicit structure the writer already knows but didn't articulate.
You infer missing concepts, bridge gaps, and make hidden relationships explicit.
QUALITY MATTERS: you preserve the writer's original meaning faithfully.
You do NOT over-process, hallucinate, or add unnecessary complexity.
When the original notes are already clear and complete, you recognise that and score high.

CRITICAL OUTPUT RULES:
- Always respond with valid JSON only. No markdown, no explanation, no code fences.
- Every response must be a single valid JSON object parseable by JSON.parse().
- Be CONCISE in summaries: 1-2 short sentences max per node.
- Keep titles short: 2-5 words.
- Use minimal tags: 1-3 per node.
- Do NOT repeat the input text verbatim in summaries — distill the core idea.
- Avoid overly verbose edge labels — use 1-3 word specific verbs."""

PROJECT_NOTES = """
TradingView Notes App — A Next.js 14 note-taking application for stock/trading analysis.

TECH STACK:
- Next.js 14 with App Router
- React 18, TypeScript
- Supabase for cloud persistence (PostgreSQL + realtime subscriptions)
- LocalStorage fallback (storage.ts) for offline
- CSS custom properties for theming (globals.css)

DATA MODEL:
- Note: id, ticker, body, tags[], created (timestamp)
- Tag: id, name, color (index into PALETTE)
- PALETTE: 10 predefined color schemes (bg, text, dot, border)
- DEFAULT_TAGS: Bullish, Bearish, Watchlist, Trade idea, Review

STATE MANAGEMENT:
- AppContext (React Context + useReducer) manages all app state
- 16 action types: SET_NOTES, SET_TAGS, ADD_NOTE, UPDATE_NOTE, DELETE_NOTE, SET_ACTIVE_ID, SET_FILTER, SET_CUSTOM_RANGE, TOGGLE_TAG_FILTER, CLEAR_TAG_FILTERS, SET_SORT_MODE, SET_SEARCH_QUERY, SET_MOBILE_PANEL, ADD_TAG, UPDATE_TAG, DELETE_TAG
- getFilteredNotes() applies date filters, tag filters, search query, and sorting
- countFor() returns count of notes matching a specific date filter

COMPONENTS:
- Topbar: search, new note button, CSV import/export/delete, mobile back button
- Sidebar: date filters (all/today/week/month/quarter/year/custom), tag filters, add/rename/delete tags
- NotesPanel: paginated note cards (20 per page), infinite scroll with IntersectionObserver, sort (newest/oldest/ticker A-Z)
- Editor: ticker input (auto-uppercase), rich text body with Bold (Ctrl+B) and Numbered List (Ctrl+L), tag toggles, auto-save (600ms debounce)
- MobileEditorFooter: word count, copy/delete/save actions (mobile only)
- Modals: delete note confirm, delete tag confirm, rename tag with color picker
- Toast: notification system with global showToast() function

CUSTOM HOOK:
- useNotes(): wraps AppContext, provides all CRUD operations (createNote, openNote, updateCurrentNote, scheduleAutoSave, deleteNote, copyNote, toggleEditorTag), CSV import/export (exportAllNotes, importNotesFromCSV, deleteMatchingNotes), and tag management (addTag, updateTag, deleteTag)

PERSISTENCE (Supabase):
- Tables: notes, tags, seed_status
- Realtime subscriptions via postgres_changes channel
- seedIfEmpty() populates 5 seed notes (AAPL, TSLA, NVDA, SPY, META) on first load
- Client-side IDs (client_id) used as primary keys
- All CRUD operations dispatch to reducer AND call Supabase

PERSISTENCE (LocalStorage fallback):
- storage.ts provides loadNotes/saveNotes/loadTags/saveTags
- createSeedNotes() generates same 5 seed notes
- Currently Supabase is the active persistence layer

UTILITIES:
- uid(): random ID generation
- relDate(): relative date formatting (just now, 5m ago, 2d ago)
- fullDate(): full date string
- Date helpers: startOfDay/Week/Month/Quarter/Year
- CSV parsing: parseCSVLine(), parseNotesFromCSV() with dedup, exportNotesToCSV()
- escHtml(): HTML entity escaping

KEYBOARD SHORTCUTS:
- Ctrl+S: Save note
- Ctrl+N: New note
- Ctrl+B: Bold in editor
- Ctrl+L: Numbered list in editor
- Escape: Close modals

MOBILE RESPONSIVE:
- 3-panel layout (sidebar, notes, editor) with slide transitions
- data-panel attribute controls visible panel
- Bottom nav bar with Filters/Notes/Editor tabs
- MobileEditorFooter replaces desktop editor footer
- Touch-optimized tap targets
"""

def call_api(system_prompt, user_prompt, max_tokens=4096):
    payload = {
        "apiKey": API_KEY,
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]
    }
    headers = {"Content-Type": "application/json"}
    
    try:
        resp = requests.post(API_URL, json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        
        # Try to parse as JSON
        # Strip markdown code fences if present
        cleaned = content.strip()
        if cleaned.startswith("```"):
            lines = cleaned.split("\n")
            # Remove first and last lines (code fences)
            lines = [l for l in lines if not l.strip().startswith("```")]
            cleaned = "\n".join(lines)
        
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"JSON parse error: {e}")
        print(f"Raw content: {content[:500]}")
        return None
    except Exception as e:
        print(f"API error: {e}")
        return None

# ====== STEP 1: EXTRACT ======
print("=" * 60)
print("STEP 1: EXTRACT — Identifying atomic concepts...")
print("=" * 60)

extract_prompt = f"""Extract atomic concepts from these notes. Each concept = ONE idea only.

Rules:
- Identify explicit AND implicit concepts (what's assumed but not named)
- Infer "glue" concepts that connect ideas but are left unsaid
- Title: 2-5 words. Summary: 1-2 SHORT sentences explaining WHY it matters.
- Preserve the writer's intent. Minor wording differences are NOT new concepts.
- Tags: 1-3 descriptive tags for grouping.
- Be CONCISE — do NOT repeat input text verbatim.

Return JSON: {{ "nodes": [{{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }}] }}

Raw notes:
{PROJECT_NOTES}"""

nodes_result = call_api(SYSTEM_PROMPT, extract_prompt)

if nodes_result and "nodes" in nodes_result:
    nodes = nodes_result["nodes"]
    print(f"Extracted {len(nodes)} nodes")
    for n in nodes:
        print(f"  {n['id']}: {n['title']} [{', '.join(n.get('tags', []))}]")
    
    # Save intermediate result
    with open("/home/z/my-project/download/atomic_graph_nodes.json", "w") as f:
        json.dump(nodes_result, f, indent=2)
else:
    print("EXTRACT failed, using fallback nodes")
    nodes = []

# ====== STEP 2: LINK ======
print("\n" + "=" * 60)
print("STEP 2: LINK — Mapping relationships...")
print("=" * 60)

node_list = ", ".join([f"{n['id']}: {n['title']}" for n in nodes])

link_prompt = f"""Map relationships between these atomic concepts.

Find both direct and implicit relationships:
- Direct: A enables B, A requires B, A is a subtype of B
- Implicit: A and B connected through unstated C
- Causal: A leads to B which enables C

Edge labels: use SPECIFIC verbs ("requires", "enables", "feeds into", "constrains", "extends"), NOT generic "related to".
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

edges_result = call_api(SYSTEM_PROMPT, link_prompt)

if edges_result and "edges" in edges_result:
    edges = edges_result["edges"]
    print(f"Created {len(edges)} edges")
    for e in edges:
        print(f"  {e['source']} --[{e['label']} ({e['strength']})]--> {e['target']}")
    
    with open("/home/z/my-project/download/atomic_graph_edges.json", "w") as f:
        json.dump(edges_result, f, indent=2)
else:
    print("LINK failed, using fallback edges")
    edges = []

# ====== STEP 3: VALIDATE ======
print("\n" + "=" * 60)
print("STEP 3: VALIDATE — Scoring graph quality...")
print("=" * 60)

full_graph = {"nodes": nodes, "edges": edges}

validate_prompt = f"""Evaluate this knowledge graph for quality and semantic fidelity.

Axes (weight: semantic fidelity > atomicity > completeness > relationships > structure):
1. SEMANTIC FIDELITY: Does it preserve the writer's meaning?
2. ATOMICITY: Is each concept truly one idea?
3. COMPLETENESS: Are implicit concepts captured?
4. RELATIONSHIP QUALITY: Specific edge labels vs lazy ones?
5. STRUCTURAL INTEGRITY: Orphan nodes? Missing cross-links?

Scoring:
- 0.90-1.00: Faithful, minor wording differences only
- 0.75-0.89: Minor gaps
- 0.50-0.74: Significant gaps
- 0.00-0.49: Major problems

Be FAIR — clear notes + good graph = high score.

ORIGINAL NOTES:
{PROJECT_NOTES}

Graph: {json.dumps(full_graph)}

Return JSON: {{ "score": 0.85, "issues": ["..."], "suggestions": ["..."] }}"""

validate_result = call_api(SYSTEM_PROMPT, validate_prompt)

if validate_result:
    score = validate_result.get("score", 0)
    issues = validate_result.get("issues", [])
    suggestions = validate_result.get("suggestions", [])
    print(f"Score: {score}")
    print(f"Issues: {issues}")
    print(f"Suggestions: {suggestions}")
else:
    score = 0
    print("VALIDATE failed")

# ====== FINAL OUTPUT ======
final_output = {
    "nodes": nodes,
    "edges": edges,
    "validation": validate_result
}

with open("/home/z/my-project/download/atomic_graph_final.json", "w") as f:
    json.dump(final_output, f, indent=2, ensure_ascii=False)

print("\n" + "=" * 60)
print(f"FINAL: {len(nodes)} nodes, {len(edges)} edges, score={score}")
print("Saved to /home/z/my-project/download/atomic_graph_final.json")
print("=" * 60)
