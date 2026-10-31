// «Готово»: агент закончил задачу (работал → свободен) — он подходит к моему столу с отчётом,
// пока я не нажму «Посмотрел» или он снова не начнёт работать.
class Reports {
  constructor() { this.last = new Map(); this.items = new Map(); this.seeded = false; }

  // agents: снимок всех агентов; вызывается на каждом обновлении
  observe(agents) {
    const seen = new Set();
    for (const a of agents) {
      seen.add(a.key);
      const prev = this.last.get(a.key);
      if (a.status === 'busy' || a.status === 'waiting' || a.status === 'stopped') this.items.delete(a.key);
      else if (a.status === 'idle' && this.seeded && (prev === 'busy' || prev === 'waiting')) {
        const t = a.transcript || {};
        this.items.set(a.key, { at: Date.now(), text: String(t.lastAssistantText || '').slice(0, 6000), prompt: String(t.lastPrompt || '').slice(0, 400) });
      }
      this.last.set(a.key, a.status);
    }
    for (const k of [...this.last.keys()]) if (!seen.has(k)) { this.last.delete(k); this.items.delete(k); }
    this.seeded = true; // при старте сервера не заваливаем стол старыми «готово»
  }

  get(key) { return this.items.get(key) || null; }
  ack(key) { return this.items.delete(key); }
}

module.exports = { Reports };
