// Dependency graph over leaf tasks. A dependency on a parent task means "all of its leaves"; a
// milestone `depends:` means "all leaves of that milestone". Both are modelled as group nodes so
// the number of edges stays linear in the number of tasks.
import { type Task } from "./model";
import { type Plan } from "./resolve";
import { isEffectivelyCancelled, isLeaf, leavesOf } from "./rollup";

export interface LeafNode {
  kind: "leaf";
  task: Task;
}

export interface GroupNode {
  kind: "group";
  /** `task:T102` or `milestone:M1` */
  key: string;
  label: string;
  members: Task[];
}

export type DepNode = LeafNode | GroupNode;

export interface Requirement {
  node: DepNode;
  lagHours: number;
  /** The task (or milestone) whose attribute declared this dependency. */
  declaredBy: Task | string;
}

export interface UnknownDep {
  task: Task;
  id: string;
}

export interface DepGraph {
  /** Schedulable leaves: not cancelled (themselves or via an ancestor or milestone). */
  leaves: Task[];
  leafNode: Map<Task, LeafNode>;
  /** What each leaf waits for. */
  requirements: Map<Task, Requirement[]>;
  /** Leaves that wait (directly) on each node. */
  dependents: Map<DepNode, Task[]>;
  groups: Map<string, GroupNode>;
  /** Leaves that are part of a dependency cycle. */
  cyclic: Set<Task>;
  /** Each cycle as the list of task ids/milestones involved, for diagnostics. */
  cycles: Task[][];
  unknown: UnknownDep[];
}

export function isSchedulableTask(plan: Plan, t: Task): boolean {
  if (isEffectivelyCancelled(t)) return false;
  const m = plan.milestoneById(t.milestoneId);
  return m?.status !== "cancelled";
}

export function buildDepGraph(plan: Plan): DepGraph {
  const leaves = plan.tasks.filter((t) => isLeaf(t) && isSchedulableTask(plan, t));
  const leafNode = new Map<Task, LeafNode>();
  for (const t of leaves) leafNode.set(t, { kind: "leaf", task: t });
  const groups = new Map<string, GroupNode>();
  const requirements = new Map<Task, Requirement[]>();
  const unknown: UnknownDep[] = [];

  const nodeForTask = (t: Task): DepNode | undefined => {
    if (!isSchedulableTask(plan, t)) return undefined;
    if (isLeaf(t)) return leafNode.get(t);
    const key = `task:${t.id ?? `${t.file}:${t.line}`}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        kind: "group",
        key,
        label: t.id ?? t.title,
        members: leavesOf(t).filter((l) => leafNode.has(l)),
      };
      groups.set(key, g);
    }
    return g;
  };

  const nodeForMilestone = (id: string): GroupNode | undefined => {
    const m = plan.milestoneById(id);
    if (!m || m.status === "cancelled") return undefined;
    const key = `milestone:${m.id}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        kind: "group",
        key,
        label: m.id,
        members: leaves.filter((l) => l.milestoneId === m.id),
      };
      groups.set(key, g);
    }
    return g;
  };

  // Unknown references are reported once, on the task that declares them.
  for (const t of plan.tasks) {
    for (const d of t.deps) if (!plan.taskById(d.id)) unknown.push({ task: t, id: d.id });
  }

  for (const leaf of leaves) {
    const reqs: Requirement[] = [];
    for (let t: Task | undefined = leaf; t; t = t.parent) {
      for (const d of t.deps) {
        const target = plan.taskById(d.id);
        if (!target) continue;
        const node = nodeForTask(target);
        if (node) reqs.push({ node, lagHours: d.lagHours, declaredBy: t });
      }
    }
    const milestone = plan.milestoneById(leaf.milestoneId);
    for (const dep of milestone?.depends ?? []) {
      const node = nodeForMilestone(dep);
      if (node) reqs.push({ node, lagHours: 0, declaredBy: milestone!.id });
    }
    requirements.set(leaf, reqs);
  }

  const dependents = new Map<DepNode, Task[]>();
  for (const [leaf, reqs] of requirements) {
    for (const r of reqs) {
      const list = dependents.get(r.node);
      if (list) list.push(leaf);
      else dependents.set(r.node, [leaf]);
    }
  }

  const { cyclic, cycles } = findCycles(leaves, leafNode, requirements, groups);
  return { leaves, leafNode, requirements, dependents, groups, cyclic, cycles, unknown };
}

/** Tarjan's strongly connected components over leaf and group nodes. */
function findCycles(
  leaves: Task[],
  leafNode: Map<Task, LeafNode>,
  requirements: Map<Task, Requirement[]>,
  groups: Map<string, GroupNode>
): { cyclic: Set<Task>; cycles: Task[][] } {
  const nodes: DepNode[] = [...leaves.map((l) => leafNode.get(l)!), ...groups.values()];
  const edges = (n: DepNode): DepNode[] =>
    n.kind === "leaf"
      ? (requirements.get(n.task) ?? []).map((r) => r.node)
      : n.members.map((m) => leafNode.get(m)!).filter(Boolean);

  const index = new Map<DepNode, number>();
  const low = new Map<DepNode, number>();
  const onStack = new Set<DepNode>();
  const stack: DepNode[] = [];
  let counter = 0;
  const cyclic = new Set<Task>();
  const cycles: Task[][] = [];

  // Iterative Tarjan to stay safe on deep chains.
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ node: DepNode; next: DepNode[]; i: number }> = [];
    const visit = (n: DepNode) => {
      index.set(n, counter);
      low.set(n, counter);
      counter++;
      stack.push(n);
      onStack.add(n);
      work.push({ node: n, next: edges(n), i: 0 });
    };
    visit(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.i < frame.next.length) {
        const w = frame.next[frame.i++];
        if (!index.has(w)) visit(w);
        else if (onStack.has(w)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const scc: DepNode[] = [];
        let w: DepNode;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== frame.node);
        const selfLoop = scc.length === 1 && edges(scc[0]).includes(scc[0]);
        if (scc.length > 1 || selfLoop) {
          const tasks = scc.filter((x): x is LeafNode => x.kind === "leaf").map((x) => x.task);
          tasks.sort((a, b) => a.order - b.order);
          for (const t of tasks) cyclic.add(t);
          if (tasks.length > 0) cycles.push(tasks);
        }
      }
    }
  }
  return { cyclic, cycles };
}

/** Tasks and milestones whose dependency declarations take part in a cycle (for diagnostics). */
export function cycleDeclarations(graph: DepGraph): { tasks: Set<Task>; milestones: Set<string> } {
  const tasks = new Set<Task>();
  const milestones = new Set<string>();
  for (const leaf of graph.cyclic) {
    for (const r of graph.requirements.get(leaf) ?? []) {
      const inCycle =
        r.node.kind === "leaf"
          ? graph.cyclic.has(r.node.task)
          : r.node.members.some((m) => graph.cyclic.has(m));
      if (!inCycle) continue;
      if (typeof r.declaredBy === "string") milestones.add(r.declaredBy);
      else tasks.add(r.declaredBy);
    }
  }
  return { tasks, milestones };
}

/**
 * True when making `successor` depend on `predecessor` would create a cycle, i.e. when some leaf
 * of `predecessor` already depends (transitively) on a leaf of `successor`.
 */
export function wouldCreateCycle(graph: DepGraph, predecessor: Task, successor: Task): boolean {
  const targets = new Set(leavesOf(successor));
  if (leavesOf(predecessor).some((l) => targets.has(l))) return true;
  const seen = new Set<Task>();
  const stack = [...leavesOf(predecessor)];
  while (stack.length) {
    const t = stack.pop()!;
    if (seen.has(t)) continue;
    seen.add(t);
    for (const r of graph.requirements.get(t) ?? []) {
      const deps = r.node.kind === "leaf" ? [r.node.task] : r.node.members;
      for (const d of deps) {
        if (targets.has(d)) return true;
        stack.push(d);
      }
    }
  }
  return false;
}
