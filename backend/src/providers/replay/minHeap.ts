// -----------------------------------------------------------------------------
// Tiny typed min-heap. Used by ReplayProvider to merge-sort per-symbol trade
// streams in chronological order without loading anything into memory.
//
// Standard binary-heap implementation — push/pop are O(log n), peek is O(1).
// No deps, no generics wizardry.
// -----------------------------------------------------------------------------

export class MinHeap<T> {
  private readonly data: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.data.length;
  }

  peek(): T | undefined {
    return this.data[0];
  }

  push(value: T): void {
    this.data.push(value);
    this.siftUp(this.data.length - 1);
  }

  pop(): T | undefined {
    const n = this.data.length;
    if (n === 0) return undefined;
    const top = this.data[0]!;
    const last = this.data.pop()!;
    if (n > 1) {
      this.data[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.data[i]!, this.data[parent]!) < 0) {
        this.swap(i, parent);
        i = parent;
      } else {
        return;
      }
    }
  }

  private siftDown(i: number): void {
    const n = this.data.length;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (
        left < n &&
        this.compare(this.data[left]!, this.data[smallest]!) < 0
      ) {
        smallest = left;
      }
      if (
        right < n &&
        this.compare(this.data[right]!, this.data[smallest]!) < 0
      ) {
        smallest = right;
      }
      if (smallest === i) return;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.data[a]!;
    this.data[a] = this.data[b]!;
    this.data[b] = tmp;
  }
}
