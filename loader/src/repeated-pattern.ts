/**
 * Fast Canvas2D repeating pattern helper for RPG Maker MV window skins.
 * Pre-tiles tiny repeating sources into a bounded stamp canvas to minimize
 * Skia draw calls when filling window backgrounds and borders.
 */

export class RepeatedPattern {
  private tile: any = null;
  private tileW = 0;
  private tileH = 0;
  private cachedRev = -1;

  constructor(
    public readonly source: any,
    public readonly repeat: string,
    private readonly getRevision: () => number,
  ) {}

  fill(
    ctx: any,
    x: number,
    y: number,
    w: number,
    h: number,
    makeCanvas: (width: number, height: number) => any,
  ): void {
    const sw = this.source?.width | 0;
    const sh = this.source?.height | 0;
    if (sw <= 0 || sh <= 0 || w <= 0 || h <= 0) return;

    const repeatX = this.repeat === 'repeat' || this.repeat === 'repeat-x';
    const repeatY = this.repeat === 'repeat' || this.repeat === 'repeat-y';

    const rev = this.getRevision();
    // Only pre-tile small pattern sources (<128px); large sources (e.g. 1000x740 battlebacks
    // or full-screen parallaxes) must NEVER be clamped down to 256px!
    const needStamp = (repeatX && sw < 128) || (repeatY && sh < 128);
    const targetTileW = repeatX && sw < 128 ? Math.max(sw, Math.min(256, Math.ceil(128 / sw) * sw)) : sw;
    const targetTileH = repeatY && sh < 128 ? Math.max(sh, Math.min(256, Math.ceil(128 / sh) * sh)) : sh;

    if (needStamp) {
      if (!this.tile || this.cachedRev !== rev || this.tileW !== targetTileW || this.tileH !== targetTileH) {
        this.tile = makeCanvas(targetTileW, targetTileH);
        const tctx = this.tile.getContext('2d');
        if (tctx) {
          for (let ty = 0; ty < targetTileH; ty += sh) {
            for (let tx = 0; tx < targetTileW; tx += sw) {
              tctx.drawImage(this.source, tx, ty);
            }
          }
        }
        this.tileW = targetTileW;
        this.tileH = targetTileH;
        this.cachedRev = rev;
      }
    } else {
      this.tile = this.source;
      this.tileW = sw;
      this.tileH = sh;
      this.cachedRev = rev;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const stepX = this.tileW;
    const stepY = this.tileH;
    // CanvasPattern is anchored at the coordinate origin (0, 0), NOT at (x, y).
    // PIXI TilingSprite translates by (modX, modY) and calls fillRect(-modX, -modY, w, h)
    // to position battlebacks (locateBattleback) and scrolling parallaxes.
    const startX = repeatX ? Math.floor(x / stepX) * stepX : 0;
    const startY = repeatY ? Math.floor(y / stepY) * stepY : 0;
    const maxX = repeatX ? x + w : startX + sw;
    const maxY = repeatY ? y + h : startY + sh;

    for (let dy = startY; dy < maxY; dy += stepY) {
      for (let dx = startX; dx < maxX; dx += stepX) {
        ctx.drawImage(this.tile, dx, dy);
      }
    }
    ctx.restore();
  }
}
