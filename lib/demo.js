// Демо-дані для гостьового входу (роль demo, окрема база): кілька задач на сьогодні, підзадачі, нотатка, дві звички з історією.
// Заповнюється один раз — коли база облікового запису порожня (meta demo_seeded).
const T = require('./assistant-time');

module.exports = function seedDemo(db, as) {
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'demo_seeded'").get()) return;
  if (db.prepare('SELECT 1 FROM assistant_items LIMIT 1').get()) return;
  const tz = as.settings().tz, today = T.dayKey(Date.now(), tz);
  // після 10:00 переносимо на завтра, щоб демо не починалось із простроченого
  const shift = +T.hhmm(Date.now(), tz).slice(0, 2) >= 10 ? 1 : 0;
  const at = (days, hm) => T.localToUtc(`${T.addDays(today, days + shift)}T${hm}`, tz);
  const add = d => as.store.createItem(d, null, tz);

  const report = add({ text: 'Підготувати звіт для клієнта', area: 'work', due_at: at(0, '15:00'), priority: 1, tags: ['клієнти'] });
  add({ text: 'Зібрати цифри за місяць', parent_id: report.id });
  add({ text: 'Оформити слайди', parent_id: report.id });
  add({ text: 'Подзвонити постачальнику', area: 'work', kind: 'reminder', due_at: at(0, '11:00') });
  add({ text: 'Купити продукти', area: 'personal', due_at: at(0, '19:00'), tags: ['магазин'] });
  add({ text: 'Пробіжка 5 км', area: 'personal', due_at: at(1, '08:00') });
  add({ text: 'Записатися до стоматолога' });
  add({ text: 'Ідея: подарунок мамі на день народження' });
  add({ kind: 'note', text: 'Книги на осінь: «Атомні звички», «Глибока робота», «Потік»', tags: ['книги'] });

  const h1 = as.habits.create({ title: 'Зарядка зранку', icon: '💪', remind: null });
  const h2 = as.habits.create({ title: 'Читати 20 хвилин', icon: '📖', remind: null });
  for (const [h, marks] of [[h1, [true, true, false, true]], [h2, [true, false, true]]])
    marks.forEach((done, i) => as.habits.mark(h.id, T.addDays(today, -(marks.length - i)), done));

  db.prepare("INSERT INTO meta (key, value) VALUES ('demo_seeded', ?)").run(String(Date.now()));
};
