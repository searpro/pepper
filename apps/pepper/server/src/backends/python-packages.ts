/**
 * Upstream repositories Pepper's Python runners drive, pinned by commit.
 *
 * Kept in a module with no imports: the Docker build installs these into the
 * image (scripts/install-python) from a layer that must only be rebuilt when
 * the installer or these pins change, not on every server edit.
 */

/**
 * numz/ComfyUI-SeedVR2_VideoUpscaler (v2.5.x): the standalone CLI the
 * `seedvr2` runner drives. Bump deliberately; its CLI flags move.
 */
export const SEEDVR2_PACKAGE =
  'https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler#4490bd1f482e026674543386bb2a4d176da245b9';
