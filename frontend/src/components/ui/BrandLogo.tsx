import { Icon, type IconName } from '../../icons'

// Shared by Connections.tsx and the portal (Home page connector rail). Uses our own
// icon set with distinct tints rather than porting ~10 bespoke brand SVG marks
// pixel-for-pixel — see js/brand-icons.js in the vanilla app for the originals.
const LOGO: Record<string, { icon: IconName; bg: string }> = {
  sap: { icon: 'database', bg: '#0FAAFF' },
  nielsen: { icon: 'barChart', bg: '#111827' },
  dms: { icon: 'file', bg: '#F97316' },
  retail: { icon: 'shoppingCart', bg: '#10B981' },
  excel: { icon: 'file', bg: '#1D6F42' },
  promo: { icon: 'history', bg: 'var(--brand-violet)' },
  powerbi: { icon: 'barChart', bg: '#F2C811' },
  snowflake: { icon: 'database', bg: '#29B5E8' },
  azure: { icon: 'database', bg: '#0078D4' },
  databricks: { icon: 'flame', bg: '#FF3621' },
}

export function BrandLogo({ logo, name }: { logo: string; name: string }) {
  const l = LOGO[logo]
  if (!l) {
    return (
      <div className="grid h-full w-full place-items-center rounded-[6px] bg-[linear-gradient(135deg,#143A63,#2568B2)] text-xs font-medium text-white">
        {name[0]}
      </div>
    )
  }
  return (
    <div className="grid h-full w-full place-items-center rounded-[6px] text-white [&_svg]:h-5 [&_svg]:w-5" style={{ background: l.bg }}>
      <Icon name={l.icon} />
    </div>
  )
}
