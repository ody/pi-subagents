export class WidgetSelection {
  private id: string | undefined;
  private index = 0;

  get selectedId(): string | undefined {
    return this.id;
  }

  get active(): boolean {
    return this.id !== undefined;
  }

  start(ids: readonly string[]): boolean {
    if (ids.length === 0) return false;
    this.place(ids, 0);
    return true;
  }

  end(): void {
    this.id = undefined;
    this.index = 0;
  }

  follow(id: string): void {
    this.id = id;
  }

  moveDown(ids: readonly string[]): void {
    this.reconcile(ids);
    if (this.id === undefined) return;
    this.place(ids, Math.min(ids.length - 1, this.index + 1));
  }

  moveUp(ids: readonly string[]): void {
    this.reconcile(ids);
    if (this.id === undefined) return;
    if (this.index === 0) this.end();
    else this.place(ids, this.index - 1);
  }

  reconcile(ids: readonly string[]): void {
    if (this.id === undefined) return;
    if (ids.length === 0) {
      this.end();
      return;
    }
    const found = ids.indexOf(this.id);
    if (found >= 0) this.index = found;
    else this.place(ids, Math.min(this.index, ids.length - 1));
  }

  private place(ids: readonly string[], index: number): void {
    this.index = index;
    this.id = ids[index];
  }
}
