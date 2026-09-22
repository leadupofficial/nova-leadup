'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type MouseEvent, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { clearTokens, decodeJwt } from '../components/AdminAuthGuard';
import { groupForPath, visibleNavGroups } from '../lib/nav';
import type { MyPermissions } from '../lib/api';

const TOKEN_KEY = 'admin_token';

interface AdminIdentity {
	email: string | null;
	role: string | null;
}

const EMPTY_IDENTITY: AdminIdentity = { email: null, role: null };

let cachedToken: string | null | undefined;
let cachedIdentity: AdminIdentity = EMPTY_IDENTITY;

/**
 * The admin identity lives in `localStorage`, which does not exist on the server.
 * Exposed as an external store rather than copied into state from a mount effect:
 * `setState` in an effect body forces a second render on every mount and is an error
 * under `react-hooks/set-state-in-effect`. `useSyncExternalStore` reads the client value
 * during render and returns the server snapshot during SSR, so hydration matches.
 */
function subscribeToAdminIdentity(onStoreChange: () => void) {
	window.addEventListener('storage', onStoreChange);
	return () => window.removeEventListener('storage', onStoreChange);
}

function getAdminIdentitySnapshot(): AdminIdentity {
	let token: string | null = null;
	try {
		token = window.localStorage.getItem(TOKEN_KEY);
	} catch {
		token = null;
	}
	if (token !== cachedToken) {
		cachedToken = token;
		const payload = token ? decodeJwt(token) : null;
		cachedIdentity = payload
			? { email: payload.email || null, role: payload.role || null }
			: EMPTY_IDENTITY;
	}
	return cachedIdentity;
}

function getServerAdminIdentitySnapshot(): AdminIdentity {
	return EMPTY_IDENTITY;
}

export default function AdminSidebar({ authority }: { authority: MyPermissions | null }) {
	const router = useRouter();
	const pathname = usePathname();
	const [showDropdown, setShowDropdown] = useState(false);
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	const identity = useSyncExternalStore(
		subscribeToAdminIdentity,
		getAdminIdentitySnapshot,
		getServerAdminIdentitySnapshot,
	);

	const userEmail = identity.email;
	const userRole = identity.role;

	/**
	 * The permissions the **server** resolved for this operator on the request that loaded the app.
	 *
	 * This used to be computed here, from the role claim in the token, against a copy of the matrix in
	 * `lib/permissions.ts`. That copy could not see a database grant, which overrides the claim — so an
	 * operator whose grant differed from their token saw destinations for the claim: some they could
	 * not open, and missing ones they could. Asking the server removes both the drift and the wrong
	 * answer, and the copy is gone.
	 */
	// Navigation is filtered by the server's answer, so an operator is not offered destinations that
	// would answer 403 and is not denied ones they can open. Still presentation only: the API resolves
	// the role independently on every request and remains the authority.
	const groups = useMemo(
		() => (authority ? visibleNavGroups(authority.permissions) : []),
		[authority],
	);
	const activeGroup = pathname ? groupForPath(pathname) : null;

	// Groups start expanded. Collapsing is remembered for the session only, which is
	// enough: an operator who collapses "Analytics" does not want it reopening on every
	// navigation, and nothing here needs to survive a reload.
	const toggleGroup = useCallback((groupId: string) => {
		setCollapsed((previous) => ({ ...previous, [groupId]: !(previous[groupId] ?? false) }));
	}, []);

	const handleLogout = useCallback(() => {
		clearTokens();
		router.replace('/login');
	}, [router]);

	const handleOutsideClick = useCallback((event: MouseEvent) => {
		if (!event.currentTarget.contains(event.target as Node)) {
			setShowDropdown(false);
		}
	}, []);

	const isActive = useCallback(
		(href: string) => pathname === href || (href !== '/' && pathname?.startsWith(`${href}/`)),
		[pathname],
	);

	return (
		<nav
			onClick={handleOutsideClick}
			style={{
				width: '256px',
				background: '#141428',
				color: '#fff',
				position: 'fixed',
				height: '100vh',
				display: 'flex',
				flexDirection: 'column',
				borderRight: '1px solid #24243f',
			}}
		>
			{/* Brand header */}
			<div style={{ padding: '1.1rem 1.25rem', borderBottom: '1px solid #24243f', flexShrink: 0 }}>
				<h1 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, letterSpacing: '-0.01em' }}>
					NOVA Control
				</h1>
				<p style={{ margin: '0.15rem 0 0', fontSize: '0.7rem', color: '#8b8ba7' }}>
					Operational control center
				</p>
			</div>

			{/* Grouped navigation */}
			<div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem 0' }}>
				{groups.map((group) => {
					const collapsedNow = collapsed[group.id] ?? false;
					const containsActive = activeGroup === group.id;
					return (
						<div key={group.id} style={{ marginBottom: '0.15rem' }}>
							<button
								type="button"
								onClick={() => toggleGroup(group.id)}
								aria-expanded={!collapsedNow}
								style={{
									width: '100%',
									display: 'flex',
									alignItems: 'center',
									gap: '0.35rem',
									padding: '0.55rem 1rem 0.35rem',
									background: 'transparent',
									border: 'none',
									color: containsActive ? '#c7d2fe' : '#71718f',
									fontSize: '0.66rem',
									fontWeight: 700,
									textTransform: 'uppercase',
									letterSpacing: '0.07em',
									cursor: 'pointer',
									textAlign: 'left',
								}}
							>
								<span style={{ fontSize: '0.6rem', width: '8px' }} aria-hidden>
									{collapsedNow ? '▸' : '▾'}
								</span>
								{group.label}
							</button>

							{collapsedNow
								? null
								: group.items.map((item) => {
										const active = isActive(item.href);
										return (
											<Link
												key={item.href}
												href={item.href}
												title={item.description}
												style={{
													display: 'block',
													padding: '0.45rem 1rem 0.45rem 1.9rem',
													color: active ? '#fff' : '#a5a5bd',
													textDecoration: 'none',
													fontSize: '0.83rem',
													background: active ? '#232347' : 'transparent',
													borderLeft: active ? '2px solid #6366f1' : '2px solid transparent',
													transition: 'background 0.12s, color 0.12s',
												}}
											>
												{item.label}
											</Link>
										);
									})}
						</div>
					);
				})}

				{groups.length === 0 ? (
					<p style={{ padding: '1rem 1.25rem', fontSize: '0.78rem', color: '#8b8ba7', lineHeight: 1.5 }}>
						Your role ({userRole ?? 'unknown'}) has no permissions in this console. Ask an administrator to
						assign one.
					</p>
				) : null}
			</div>

			{/* User info + logout */}
			<div style={{ padding: '0.85rem 1rem', borderTop: '1px solid #24243f', position: 'relative', flexShrink: 0 }}>
				<div
					onClick={() => setShowDropdown((previous) => !previous)}
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: '0.65rem',
						cursor: 'pointer',
						padding: '0.35rem 0',
						userSelect: 'none',
					}}
					role="button"
					aria-expanded={showDropdown}
					aria-haspopup="true"
					tabIndex={0}
					onKeyDown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							setShowDropdown((previous) => !previous);
						}
					}}
				>
					<div
						style={{
							width: '30px',
							height: '30px',
							borderRadius: '50%',
							background: '#6366f1',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							fontSize: '0.8rem',
							fontWeight: 600,
							color: '#fff',
							flexShrink: 0,
						}}
					>
						{userEmail ? userEmail.charAt(0).toUpperCase() : 'U'}
					</div>
					<div style={{ minWidth: 0, flex: 1 }}>
						<p
							style={{
								margin: 0,
								fontSize: '0.76rem',
								fontWeight: 500,
								color: '#f8fafc',
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							}}
						>
							{userEmail || 'not signed in'}
						</p>
						<p style={{ margin: '0.1rem 0 0', fontSize: '0.68rem', color: '#818cf8' }}>
							{authority?.adminRole ?? userRole ?? 'unknown role'} ·{' '}
							{authority ? `${authority.permissions.length} permissions` : 'access not resolved'}
						</p>
					</div>
					<span style={{ fontSize: '0.65rem', color: '#64748b' }} aria-hidden>
						▾
					</span>
				</div>

				{showDropdown ? (
					<div
						style={{
							position: 'absolute',
							bottom: '100%',
							left: '1rem',
							right: '1rem',
							marginBottom: '0.5rem',
							background: '#1c1c38',
							border: '1px solid #2a2a4a',
							borderRadius: '8px',
							overflow: 'hidden',
							boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
							zIndex: 50,
						}}
					>
						<Link
							href="/permissions"
							style={{
								display: 'block',
								padding: '0.6rem 0.9rem',
								color: '#c7d2fe',
								fontSize: '0.78rem',
								textDecoration: 'none',
							}}
						>
							View my permissions
						</Link>
						<button
							type="button"
							onClick={handleLogout}
							style={{
								width: '100%',
								padding: '0.6rem 0.9rem',
								background: 'transparent',
								color: '#f87171',
								border: 'none',
								borderTop: '1px solid #2a2a4a',
								fontSize: '0.78rem',
								cursor: 'pointer',
								textAlign: 'left',
							}}
						>
							Sign out
						</button>
					</div>
				) : null}
			</div>
		</nav>
	);
}
