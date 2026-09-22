'use client'

import { useState, useCallback, useRef } from 'react'
import { Notification, NotificationType } from './NotificationCenter'

let idCounter = 0
const generateId = () => `notification-${Date.now()}-${++idCounter}`

export interface NotificationOptions {
 type?: NotificationType
 duration?: number
 action?: { label: string; onClick: () => void }
 persistent?: boolean
}

type Listener = (notifications: Notification[]) => void

export function useNotifications() {
 const [notifications, setNotifications] = useState<Notification[]>([])
 const listenersRef = useRef<Set<Listener>>(new Set())

 const subscribe = useCallback((listener: Listener) => {
 listenersRef.current.add(listener)
 return () => listenersRef.current.delete(listener)
 }, [])

 const notify = useCallback((notifications: Notification[]) => {
 listenersRef.current.forEach((listener) => listener(notifications))
 }, [])

 const add = useCallback(
 (title: string, message?: string, options?: NotificationOptions) => {
 const notification: Notification = {
 id: generateId(),
 type: options?.type ?? 'info',
 title,
 message,
 duration: options?.duration ?? 5000,
 action: options?.action,
 persistent: options?.persistent ?? false,
 }

 setNotifications((prev) => {
 const next = [notification, ...prev]
 notify(next)
 return next
 })

 if (!notification.persistent && notification.duration! > 0) {
 setTimeout(() => {
 dismiss(notification.id)
 }, notification.duration)
 }

 return notification
 },
 [notify]
 )

 const dismiss = useCallback(
 (id: string) => {
 setNotifications((prev) => {
 const next = prev.filter((n) => n.id !== id)
 notify(next)
 return next
 })
 },
 [notify]
 )

 const dismissAll = useCallback(() => {
 setNotifications([])
 notify([])
 }, [notify])

 const success = useCallback(
 (title: string, message?: string, options?: Omit<NotificationOptions, 'type'>) =>
 add(title, message, { ...options, type: 'success' }),
 [add]
 )

 const error = useCallback(
 (title: string, message?: string, options?: Omit<NotificationOptions, 'type'>) =>
 add(title, message, { ...options, type: 'error', persistent: true }),
 [add]
 )

 const warning = useCallback(
 (title: string, message?: string, options?: Omit<NotificationOptions, 'type'>) =>
 add(title, message, { ...options, type: 'warning', persistent: true }),
 [add]
 )

 const info = useCallback(
 (title: string, message?: string, options?: Omit<NotificationOptions, 'type'>) =>
 add(title, message, { ...options, type: 'info' }),
 [add]
 )

 return {
 notifications,
 add,
 dismiss,
 dismissAll,
 success,
 error,
 warning,
 info,
 subscribe,
 }
}
