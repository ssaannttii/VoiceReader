/**
 * The paginated reading layout's DOM side: the article becomes a run of CSS
 * columns exactly one page wide (an integer number of px, so pages never drift)
 * inside a clipping viewport, and a page is shown by translating the run.
 * Page geometry is read from line boxes relative to the article itself, so it
 * is the same mid-animation as at rest. Rules live in reader-pages.ts.
 */
import { clampPage, dragOffset, PAGE_GAP, pageOfOffset } from './reader-pages';

/** Page-turn slide; reduced motion turns instantly. */
const TURN = 'transform 300ms cubic-bezier(0.2, 0.75, 0.25, 1)';

export class Pager {
  page = 0;
  count = 1;
  pitch = PAGE_GAP + 1;
  private width = 0;
  private height = 0;
  private x: number | null = null;

  constructor(
    readonly viewport: HTMLElement,
    readonly article: HTMLElement,
  ) {}

  /** Size the columns to the viewport; true when the page size changed. */
  fit(): boolean {
    const box = this.viewport.getBoundingClientRect();
    const width = Math.max(1, Math.floor(box.width));
    const height = Math.max(1, Math.floor(box.height));
    if (width === this.width && height === this.height) return false;
    this.width = width;
    this.height = height;
    this.pitch = width + PAGE_GAP;
    const style = this.article.style;
    style.width = `${width}px`;
    style.height = `${height}px`;
    style.columnWidth = `${width}px`;
    style.columnGap = `${PAGE_GAP}px`;
    style.setProperty('--rd-page-h', `${height}px`);
    this.x = null;
    return true;
  }

  /** Count the pages: `end` is an empty element after the last block. */
  measure(end: Element | null) {
    const last = end ? this.offset(end, false) : this.article.scrollWidth - this.width;
    this.count = Math.max(1, pageOfOffset(last, this.pitch) + 1);
    if (this.page >= this.count) this.page = this.count - 1;
  }

  /** Horizontal offset of an element's first (or last) line box from the article's start. */
  private offset(element: Element, last: boolean): number {
    const rects = element.getClientRects();
    const rect = rects.length
      ? rects[last ? rects.length - 1 : 0]
      : element.getBoundingClientRect();
    return rect.left - this.article.getBoundingClientRect().left;
  }

  /** Page where an element starts (or, with `last`, ends). */
  pageOf(element: Element, last = false): number {
    return clampPage(pageOfOffset(this.offset(element, last), this.pitch), this.count);
  }

  /** Part of the element is on the page shown. */
  shows(element: Element): boolean {
    return this.pageOf(element) <= this.page && this.page <= this.pageOf(element, true);
  }

  show(page: number, animate: boolean) {
    this.page = clampPage(page, this.count);
    this.translate(-this.page * this.pitch, animate);
  }

  /** Follow a finger pulling the page sideways by `dx` px. */
  drag(dx: number) {
    this.translate(-this.page * this.pitch + dragOffset(dx, this.page, this.count), false);
  }

  private translate(x: number, animate: boolean) {
    // Same place: leave a slide in progress alone.
    if (x === this.x) return;
    this.x = x;
    const style = this.article.style;
    style.transition = animate ? TURN : 'none';
    style.transform = `translate3d(${x}px, 0, 0)`;
  }
}
