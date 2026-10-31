import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official whale mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <FishLogo size={size} />
}

/**
 * Render the official name artwork without its independently slotted mark.
 * @returns the official name wordmark.
 */
export function OfficialBrandName() {
  return <BrandWordmark includeMark={false} />
}

/** Render the supplied HMWORK mascot at a sidebar size. */
export function HmworkBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <img src="/hmwork-mark-34.png" width={size} height={size} alt="" aria-hidden="true" />
}

/** Render the supplied HMWORK mascot in the hero mark slot. */
export function HmworkHeroMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <img src="/hmwork-mark-34.png" width={size} height={size} className={className} alt="" aria-hidden="true" />
}
