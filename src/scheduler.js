// scheduler.js — 定时任务调度器
// 读取 tasks.json，注册 cron 任务，支持热加载

import cron from 'node-cron';
import { readFile, writeFile } from 'fs/promises';

const TASKS_FILE = process.env.TASKS_FILE || new URL('../tasks.json', import.meta.url);

let activeTasks = []; // { name, task: ScheduledTask }
let deps = { runAgentQuery: null, sendMessage: null };

export async function startScheduler({ runAgentQuery, sendMessage }) {
  deps.runAgentQuery = runAgentQuery;
  deps.sendMessage = sendMessage;
  await reloadScheduler();
}

// 停掉所有已注册的 cron
function stopAll() {
  for (const entry of activeTasks) {
    entry.task.stop();
  }
  activeTasks = [];
}

// 重新读取 tasks.json 并注册所有 enabled 的任务
export async function reloadScheduler() {
  stopAll();

  let tasks;
  try {
    const raw = await readFile(TASKS_FILE, 'utf-8');
    tasks = JSON.parse(raw);
  } catch {
    console.log('[scheduler] no tasks.json found, skip');
    return;
  }

  const enabled = tasks.filter(t => t.enabled);
  if (enabled.length === 0) {
    console.log(`[scheduler] 0/${tasks.length} tasks enabled`);
    return;
  }

  for (const task of enabled) {
    if (!cron.validate(task.cron)) {
      console.error(`[scheduler] invalid cron: ${task.name} → ${task.cron}`);
      continue;
    }

    const scheduled = cron.schedule(task.cron, async () => {
      console.log(`[scheduler] firing: ${task.name}`);
      try {
        const result = await deps.runAgentQuery(task.prompt);
        if (task.sendTo && result) {
          await deps.sendMessage(task.sendTo, result);
        }
      } catch (err) {
        console.error(`[scheduler] ${task.name} failed: ${err.message}`);
      }
    });

    activeTasks.push({ name: task.name, task: scheduled });
    console.log(`[scheduler] registered: ${task.name} (${task.cron})`);
  }

  console.log(`[scheduler] ${enabled.length}/${tasks.length} tasks running`);
}

// CRUD helpers — Agent 调用这些操作 tasks.json，然后触发 reload

export async function listTasks() {
  const raw = await readFile(TASKS_FILE, 'utf-8');
  return JSON.parse(raw);
}

export async function addTask(task) {
  const tasks = await listTasks();
  if (tasks.find(t => t.name === task.name)) {
    throw new Error(`任务 "${task.name}" 已存在，请用其他名称`);
  }
  if (!cron.validate(task.cron)) {
    throw new Error(`无效的 cron 表达式: ${task.cron}`);
  }
  tasks.push(task);
  await writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2) + '\n');
  await reloadScheduler();
  return task;
}

export async function updateTask(name, updates) {
  const tasks = await listTasks();
  const idx = tasks.findIndex(t => t.name === name);
  if (idx === -1) throw new Error(`任务 "${name}" 不存在`);
  if (updates.cron && !cron.validate(updates.cron)) {
    throw new Error(`无效的 cron 表达式: ${updates.cron}`);
  }
  tasks[idx] = { ...tasks[idx], ...updates };
  await writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2) + '\n');
  await reloadScheduler();
  return tasks[idx];
}

export async function removeTask(name) {
  const tasks = await listTasks();
  const filtered = tasks.filter(t => t.name !== name);
  if (filtered.length === tasks.length) throw new Error(`任务 "${name}" 不存在`);
  await writeFile(TASKS_FILE, JSON.stringify(filtered, null, 2) + '\n');
  await reloadScheduler();
  return true;
}
