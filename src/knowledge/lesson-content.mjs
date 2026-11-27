// 标题只用于辨认，正式正文必须保留完整经验；兼容旧灵感经验只存短现象的记录。
export function lessonContent(lesson, { ownerStore } = {}) {
  if (typeof lesson?.content === 'string' && lesson.content.trim()) {
    const body=lesson.content.trim();
    return [body,lesson.mechanism&&!body.includes(lesson.mechanism)?`机制：${lesson.mechanism}`:'',lesson.countermeasure&&!body.includes(lesson.countermeasure)?`对策：${lesson.countermeasure}`:''].filter(Boolean).join('\n\n');
  }
  if (lesson?.extractor === 'idea-receipt') {
    const original = ownerStore?.getIdeaItem?.(lesson.sourceRecordId);
    if (original?.rawText?.trim()) return original.rawText.trim();
    const excerpts = (lesson.evidence ?? []).filter(row => row.kind === 'idea' && row.excerpt).map(row => row.excerpt.trim());
    if (excerpts.length) return [...new Set(excerpts)].join('\n\n');
  }
  return [lesson?.phenomenon, lesson?.mechanism && `机制：${lesson.mechanism}`, lesson?.countermeasure && `对策：${lesson.countermeasure}`].filter(Boolean).join('\n');
}
