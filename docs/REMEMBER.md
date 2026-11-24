# Johnny Remember

Create memories in Johnny's knowledge graph via four different entry points.

## CLI Command

```bash
johnny remember "Title" --content="Memory content here"
```

**Arguments:**
- `"Title"` - Required title for the memory
- `--content="..."` - Optional transcript/body content

**Example:**
```bash
johnny remember "API Auth" --content="Bearer token required for all API calls"
```

**Output:**
```
◈ memory saved · api-auth
  bearer, token, required, calls
```

---

## MCP Tool

Call via any MCP client (Claude Code, Claude Desktop, etc.):

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "tools/call",
  "params": {
    "name": "johnny_remember",
    "arguments": {
      "title": "Memory Title",
      "transcript": "The full memory content to store"
    }
  }
}
```

**Parameters:**
- `title` (required) - Short title/summary
- `transcript` (required) - Full body content

**Response:**
```json
{
  "content": [{
    "type": "text",
    "text": "Memory created: API Auth\nName: api-auth\nTopics: bearer, token\nTokens: 12"
  }]
}
```

---

## Natural Language (evaluate.ts)

Johnny's evaluate hook detects memory creation triggers in user prompts:

**Trigger Phrases:**
- `remember that...`
- `note that...`
- `save this to memory...`
- `make a memory about...`
- `write this down...`
- `create a memory`

**Example Input:**
```
remember that the database uses postgres
```

**Automatic Process:**
1. evaluate.ts receives the prompt
2. `detectMemoryIntent()` identifies trigger
3. Extracts topic and generates title
4. Creates memory automatically
5. Returns confirmation via systemMessage

**Output:**
```
◈ memory saved · the-database-uses-postgres
  topics: database, uses, postgres
```

---

## Slash Command

Available in Claude Code sessions:

```bash
/remember "Title"
```

Or just `/remember` for interactive prompt.

---

## Memory Structure

All variants create identical memories with:

```json
{
  "id": "uuid",
  "snapshotName": "slugified-title",
  "title": "Original Title",
  "summary": "First 200 chars...",
  "transcript": "Full content",
  "embedding": null,
  "topics": ["extracted", "keywords"],
  "projectPath": "current/working/dir",
  "tokenCount": 42,
  "retrievalCount": 0,
  "rank": 0.15,
  "outgoingEdges": {},
  "incomingEdges": {}
}
```

---

## Related Tools

- `johnny_recall` - Search memories by query
- `johnny_list` - List all memories
- `johnny_graph` - Get graph statistics