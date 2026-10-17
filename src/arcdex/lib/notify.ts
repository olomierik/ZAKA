// The browser's permission for system notifications (alerts, profits), asked when someone turns them on. Its own small
// module, so the account menu doesn't load the discovery panel for it.
export async function enableAlertNotifications(): Promise<boolean> {
  if (!('Notification' in window)) return false
  const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  return p === 'granted'
}
