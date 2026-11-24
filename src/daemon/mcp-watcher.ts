// MCP tool call watcher — tracks when johnny_recall is called and reinforces edges.
import { log } from '../utils/log.js';
import { readGraph, writeGraph } from '../store/graph.js';
import { readState } from '../store/state.js';
import { readConfig } from '../store/config.js';

interface McpToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  timestamp: string;
}

export async function trackMcpRecall(
  memoryNames: string[],
  currentTurn: number
): Promise<void> {
  if (memoryNames.length < 2) return;

  try {
    const [graph, config] = await Promise.all([
      readGraph(),
      readConfig(),
    ]);

    const memories = Object.values(graph.memories);
    
    // Build a map for quick lookup
    const nameToId = new Map<string, string>();
    for (const mem of memories) {
      nameToId.set(mem.snapshotName, mem.id);
    }

    // Reinforce edges between all pairs of retrieved memories
    for (let i = 0; i < memoryNames.length; i++) {
      for (let j = i + 1; j < memoryNames.length; j++) {
        const idA = nameToId.get(memoryNames[i]);
        const idB = nameToId.get(memoryNames[j]);
        
        if (!idA || !idB) continue;
        if (idA === idB) continue;

        const memA = graph.memories[idA];
        const memB = graph.memories[idB];

        if (!memA || !memB) continue;

        // Get or create edge
        let edge = memA.outgoingEdges[idB];
        if (!edge) {
          edge = {
            weight: 0,
            coRetrievalCount: 0,
            lastReinforcedTurn: currentTurn,
            lastReinforcedAt: new Date().toISOString(),
            invalidationCount: 0,
            lastInvalidatedTurn: null,
          };
          memA.outgoingEdges[idB] = edge;
        }

        // Reinforce the edge
        edge.weight += config.reinforcementDelta;
        edge.coRetrievalCount += 1;
        edge.lastReinforcedTurn = currentTurn;
        edge.lastReinforcedAt = new Date().toISOString();

        // Also add reverse edge
        let revEdge = memB.outgoingEdges[idA];
        if (!revEdge) {
          revEdge = {
            weight: 0,
            coRetrievalCount: 0,
            lastReinforcedTurn: currentTurn,
            lastReinforcedAt: new Date().toISOString(),
            invalidationCount: 0,
            lastInvalidatedTurn: null,
          };
          memB.outgoingEdges[idA] = revEdge;
        }

        revEdge.weight += config.reinforcementDelta;
        revEdge.coRetrievalCount += 1;
        revEdge.lastReinforcedTurn = currentTurn;
        revEdge.lastReinforcedAt = new Date().toISOString();

        await log(`mcp-reinforce: ${memA.snapshotName} ↔ ${memB.snapshotName} +${config.reinforcementDelta}`);
      }

      // Update retrieval count for each retrieved memory
      const mem = memories.find(m => m.snapshotName === memoryNames[i]);
      if (mem) {
        mem.retrievalCount += 1;
        mem.lastRetrievedTurn = currentTurn;
        mem.lastRetrievedAt = new Date().toISOString();
      }
    }

    await writeGraph(graph);
  } catch (err) {
    await log(`mcp-reinforce error: ${err}`);
  }
}

export async function trackMcpToolCall(call: McpToolCall): Promise<void> {
  const state = await readState();
  const currentTurn = state.turnCounter;

  if (call.tool === 'johnny_recall') {
    const query = call.arguments.query as string;
    const limit = (call.arguments.limit as number) || 3;

    await log(`mcp-call: ${call.tool} query="${query}" limit=${limit}`);

    // Note: The actual memory names would come from the MCP server response
    // For now we just log the call �� the MCP server handles the actual recall
    // and could report back what was retrieved for edge reinforcement
  }
}