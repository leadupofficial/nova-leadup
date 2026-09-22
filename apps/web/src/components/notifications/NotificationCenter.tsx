'use client'

import React, { useState, useEffect, useCallback } from 'react'

export type NotificationType = 'info' | 'success' | 'warning' | 'error'

export interface Notification {
 id: string
 type: NotificationType
 title: string
 message?: string
 duration?: number
 action?: { label: string; onClick: () => void }
 persistent?: boolean
}

interface NotificationCenterProps {
 notifications: Notification[]
 onDismiss: (id: string) => void
 maxVisible?: number
}

const typeStyles: Record<NotificationType, { bg: string; border: string; icon: string; iconColor: string }> = {
 info: {
 bg: 'bg-blue-50',
 border: 'border-blue-200',
 icon: 'ℹ️',
 iconColor: 'text-blue-500',
 },
 success: {
 bg: 'bg-green-50',
 border: 'border-green-200',
 icon: '✓',
 iconColor: 'text-green-600',
 },
 warning: {
 bg: 'bg-yellow-50',
 border: 'border-yellow-200',
 icon: '⚠',
 iconColor: 'text-yellow-600',
 },
 error: {
 bg: 'bg-red-50',
 border: 'border-red-200',
 icon: '✕',
 iconColor: 'text-red-600',
 },
}

export function NotificationCenter({
 notifications,
 onDismiss,
 maxVisible = 5,
}: NotificationCenterProps) {
 const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set())
 const [animatingOut, setAnimatingOut] = useState<Set<string>>(new Set())

 const visibleNotifications = notifications.slice(0, maxVisible)

 const dismiss = useCallback((id: string) => {
 setAnimatingOut((prev) => new Set(prev).add(id))
 setTimeout(() => {
 onDismiss(id)
 setAnimatingOut((prev) => {
 const next = new Set(prev)
 next.delete(id)
 return next
 })
 setVisibleIds((prev) => {
 const next = new Set(prev)
 next.delete(id)
 return next
 })
 }, 200)
 }, [onDismiss])

 useEffect(() => {
 setVisibleIds((prev) => {
 const next = new Set(prev)
 visibleNotifications.forEach((n) => next.add(n.id))
 return next
 })
 }, [visibleNotifications.map((n) => n.id).join(',')])

 if (visibleNotifications.length === 0) return null

 return (
 <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-3 max-w-sm w-full pointer-events-none">
 {visibleNotifications.map((notification, index) => {
 const style = typeStyles[notification.type]
 const isAnimating = animatingOut.has(notification.id)
 const isVisible = visibleIds.has(notification.id)

 if (!isVisible) return null

 return (
 <div
 key={notification.id}
 className={`
 pointer-events-auto
 ${style.bg} ${style.border}
 border rounded-lg shadow-lg p-4
 transform transition-all duration-200 ease-in-out
 ${isAnimating ? 'opacity-0 translate-y-2' : 'opacity-100 translate-y-0'}
 `}
 style={{ animationDelay: `${index * 50}ms` }}
 role="alert"
 aria-live="polite"
 >
 <div className="flex items-start gap-3">
 <span
 className={`${style.iconColor} text-lg font-bold flex-shrink-0 mt-0.5`}
 aria-hidden="true"
 >
 {style.icon}
 </span>
 <div className="flex-1 min-w-0">
 <h4 className="font-semibold text-gray-900 text-sm">
 {notification.title}
 </h4>
 {notification.message && (
 <p className="text-gray-700 text-sm mt-0.5">
 {notification.message}
 </p>
 )}
 {notification.action && (
 <button
 onClick={() => {
 notification.action!.onClick()
 dismiss(notification.id)
 }}
 className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-800 underline"
 >
 {notification.action.label}
 </button>
 )}
 </div>
 <button
 onClick={() => dismiss(notification.id)}
 className="text-gray-400 hover:text-gray-600 flex-shrink-0"
 aria-label="Dismiss notification"
 >
 <span aria-hidden="true">×</span>
 </button>
 </div>
 </div>
 )
 })}
 </div>
 )
}
