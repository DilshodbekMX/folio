import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronDown, LogOut, ShieldCheck, UserCog } from 'lucide-react'
import { hasUnsavedRecovered } from '../../realtime/recoveredStore'
import { hasPendingDocChanges } from '../../realtime/syncState'
import { useAuth } from '../../stores/auth'
import { Avatar, DropdownMenu, confirmDialog, type MenuItem } from '../../ui'
import { AccountModal } from './AccountModal'

/**
 * Before logging out: true to go ahead. Logging out destroys the document sessions still sending
 * edits made offline (none may reconnect with this account's cookie afterwards) and discards the
 * text kept from documents closed while offline, so it asks first while there is either.
 */
async function confirmLogout(): Promise<boolean> {
  const pending = hasPendingDocChanges()
  const kept = hasUnsavedRecovered()
  if (!pending && !kept) return true
  return confirmDialog({
    title: 'Log out with unsaved changes?',
    message: (
      <>
        {pending && (
          <p>
            Some of your changes haven’t reached the server yet, because the connection is lost. If you log out now, they are
            discarded: this browser stops sending them.
          </p>
        )}
        {kept && (
          <p>
            {pending ? 'The' : 'Your'} unsaved text Folio kept from documents that were closed before the server saved it is
            discarded {pending ? 'too' : 'if you log out now'}. To keep it, open the project and copy it or save it as a new file first.
          </p>
        )}
      </>
    ),
    confirmLabel: 'Log out anyway',
    cancelLabel: 'Stay signed in',
    danger: true,
  })
}

/** Avatar button with Account settings / Admin / Log out. */
export function UserMenu({ compact = false }: { compact?: boolean }) {
  const me = useAuth(s => s.me)
  const navigate = useNavigate()
  const [accountOpen, setAccountOpen] = useState(false)
  if (!me) return null

  const items: MenuItem[] = [
    { type: 'caption', label: me.email },
    { label: 'Account settings', icon: UserCog, onSelect: () => setAccountOpen(true) },
    { label: 'Admin', icon: ShieldCheck, hidden: !me.isAdmin, onSelect: () => navigate('/admin') },
    { type: 'separator' },
    {
      label: 'Log out',
      icon: LogOut,
      onSelect: async () => {
        if (!(await confirmLogout())) return
        // signs out here at once; the login page says when the server could not be told yet
        const done = useAuth.getState().logout()
        navigate('/login', { replace: true })
        await done
      },
    },
  ]

  return (
    <>
      <DropdownMenu
        align="end"
        items={items}
        trigger={
          <button type="button" className="dash-user" aria-label={`Account menu for ${me.name}`}>
            <Avatar user={me} size={26} decorative />
            {!compact && <span className="dash-user__name">{me.name}</span>}
            <ChevronDown size={14} aria-hidden="true" className="dash-user__chev" />
          </button>
        }
      />
      <AccountModal open={accountOpen} onClose={() => setAccountOpen(false)} />
    </>
  )
}
