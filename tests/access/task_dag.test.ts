import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const lines = readFileSync('specs/002-authentication-api-access/tasks.md', 'utf8').split('\n');
interface Task { id: string; done: boolean; depends: string[] }
const tasks: Task[] = [];
for (const line of lines) {
  const match = /^- \[( |x)\] (T\d{3}) /.exec(line);
  if (!match) continue;
  const clause = /Depends: ([^\n]*)/.exec(line)?.[1] ?? '';
  // Cross-spec references such as "spec-001 T052" name tasks in another file.
  const local = clause.replace(/spec-\d{3} T\d{3}/g, '');
  tasks.push({ id: match[2]!, done: match[1] === 'x', depends: [...local.matchAll(/T\d{3}/g)].map(value => value[0]) });
}
const byId = new Map(tasks.map(task => [task.id, task]));
test('the task list has unique ids and every local dependency names an existing task', () => {
  assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length);
  for (const task of tasks) for (const dependency of task.depends) assert.ok(byId.has(dependency), `${task.id} depends on missing ${dependency}`);
});
test('no checked task depends on an unchecked task in the same list', () => {
  const violations = tasks.filter(task => task.done).flatMap(task => task.depends.filter(dependency => !byId.get(dependency)?.done).map(dependency => `${task.id}->${dependency}`));
  assert.deepEqual(violations, []);
});
test('the task list has no dependency cycles', () => {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): void => {
    if (state.get(id) === 'done') return;
    assert.notEqual(state.get(id), 'visiting', `cycle through ${id}`);
    state.set(id, 'visiting');
    for (const dependency of byId.get(id)?.depends ?? []) visit(dependency);
    state.set(id, 'done');
  };
  for (const task of tasks) visit(task.id);
});
