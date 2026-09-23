/**
 * Folio UI primitives (SPEC §6.5). Import everything from here:
 *
 *   import { Button, IconButton, Modal, DropdownMenu, toast, confirmDialog } from '../../ui'
 *
 * Floating layers (menus, tooltips, modals, toasts) render into document.body. The hosts
 * `<Toaster/>`, `<DialogHost/>` and `<ContextMenuHost/>` are mounted once by App.tsx.
 * Styles live in ui/ui.css (class prefix `ui-`), built only from the tokens in styles/tokens.css.
 */
import './ui.css'

export { Button, IconButton } from './Button'
export type { ButtonProps, ButtonVariant, IconButtonProps } from './Button'
export { Tooltip } from './Tooltip'
export type { TooltipProps, TooltipSide } from './Tooltip'
export { Modal } from './Modal'
export type { ModalProps } from './Modal'
export { DropdownMenu } from './DropdownMenu'
export type { DropdownMenuProps } from './DropdownMenu'
export type { MenuItem } from './Menu'
export { showContextMenu, hideContextMenu, ContextMenuHost } from './ContextMenu'
export { Tabs, Badge } from './Tabs'
export type { TabsProps, TabDef, BadgeTone } from './Tabs'
export { toast, dismissToast, dismissAllToasts, Toaster } from './Toast'
export type { ToastOptions, ToastTone } from './Toast'
export { confirmDialog, promptDialog, cancelAllDialogs, DialogHost } from './Dialogs'
export type { ConfirmOptions, PromptOptions } from './Dialogs'
export { Spinner } from './Spinner'
export { TextField, TextArea, Select, Checkbox, Switch, Field } from './Form'
export type { TextFieldProps, TextAreaProps, SelectProps, SelectOption, CheckboxProps, SwitchProps, FieldProps } from './Form'
export { Avatar, AvatarStack, initials, readableTextOn } from './Avatar'
export type { AvatarProps, AvatarStackProps, AvatarStackUser, AvatarUser } from './Avatar'
export { EmptyState, Kbd, Placeholder } from './Misc'
export type { EmptyStateProps, KbdProps } from './Misc'
export { Portal } from './Portal'
export { FolioLogo, FolioMark } from './Logo'
export { renderIcon } from './icon'
export type { IconProp } from './icon'
export { formatShortcut, shortcutParts, isMac, isModKey, mergeRefs } from './utils'
