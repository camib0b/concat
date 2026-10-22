/** Moves `fromIndex` to `toIndex`, leaving every other item in its relative order. */
export function moveItem<Item>(items: readonly Item[], fromIndex: number, toIndex: number): Item[] {
  if (fromIndex === toIndex) return items.slice();
  const next = items.slice();
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return next;
  const clampedIndex = Math.max(0, Math.min(toIndex, next.length));
  next.splice(clampedIndex, 0, moved);
  return next;
}

/**
 * Slots a resting file shifts while another file is dragged from `originIndex`
 * toward `previewIndex`. Negative means left, positive means right.
 */
export function slotShift(itemIndex: number, originIndex: number, previewIndex: number): number {
  if (itemIndex === originIndex) return 0;
  if (originIndex < previewIndex && itemIndex > originIndex && itemIndex <= previewIndex) return -1;
  if (originIndex > previewIndex && itemIndex >= previewIndex && itemIndex < originIndex) return 1;
  return 0;
}

/** Index shown on a file while a drag preview is active. */
export function displayedIndex(itemIndex: number, originIndex: number, previewIndex: number): number {
  if (itemIndex === originIndex) return previewIndex;
  return itemIndex + slotShift(itemIndex, originIndex, previewIndex);
}

/** Nearest slot center to the dragged file's horizontal center. Ties keep the lower index. */
export function previewIndexForPointer(centerX: number, slotCenters: readonly number[]): number {
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < slotCenters.length; index += 1) {
    const distance = Math.abs(centerX - slotCenters[index]);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  }
  return closestIndex;
}

export type SlotGeometry = {
  stride: number;
  centers: number[];
};

export function slotGeometry(
  containerWidth: number,
  containerLeft: number,
  gap: number,
  count: number,
): SlotGeometry | null {
  if (count <= 0 || containerWidth <= 0) return null;
  const slotWidth = (containerWidth - gap * (count - 1)) / count;
  if (slotWidth <= 0) return null;
  const stride = slotWidth + gap;
  const centers = Array.from(
    { length: count },
    (_, index) => containerLeft + index * stride + slotWidth / 2,
  );
  return { stride, centers };
}

export function fillReorderTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}
