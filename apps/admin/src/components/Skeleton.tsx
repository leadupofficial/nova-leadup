'use client';

/**
 * Skeleton loader for table rows.
 */
export function TableRowSkeleton({ columns = 4 }: { columns?: number }) {
	return (
		<tr>
			{Array.from({ length: columns }).map((_, i) => (
				<td key={i} style={{ padding: '0.75rem 1rem' }}>
					<div
						style={{
							height: '0.85rem',
							background: '#e5e7eb',
							borderRadius: '4px',
							width: `${60 + Math.random() * 40}%`,
							animation: 'pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
						}}
					/>
				</td>
			))}
		</tr>
	);
}

/**
 * Skeleton loader for summary cards.
 */
export function CardSkeleton() {
	return (
		<div
			style={{
				background: '#fff',
				borderRadius: '8px',
				border: '1px solid #e5e7eb',
				padding: '1.25rem',
			}}
		>
			<div
				style={{
					height: '0.8rem',
					background: '#e5e7eb',
					borderRadius: '4px',
					width: '40%',
					marginBottom: '0.75rem',
					animation: 'pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
				}}
			/>
			<div
				style={{
					height: '1.75rem',
					background: '#e5e7eb',
					borderRadius: '4px',
					width: '60%',
					animation: 'pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
				}}
			/>
		</div>
	);
}

/**
 * Full-page loading state for server-component data pages.
 */
export function PageSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
	return (
		<div>
			<div style={{ marginBottom: '1.5rem' }}>
				<div
					style={{
						height: '1.75rem',
						background: '#e5e7eb',
						borderRadius: '4px',
						width: '30%',
						marginBottom: '0.5rem',
						animation: 'pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
					}}
				/>
				<div
					style={{
						height: '0.85rem',
						background: '#e5e7eb',
						borderRadius: '4px',
						width: '20%',
						animation: 'pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
					}}
				/>
			</div>
			<div
				style={{
					background: '#fff',
					borderRadius: '8px',
					border: '1px solid #e5e7eb',
					overflow: 'hidden',
				}}
			>
				<table style={{ width: '100%', borderCollapse: 'collapse' }}>
					<thead>
						<tr style={{ background: '#f9fafb' }}>
							{Array.from({ length: columns }).map((_, i) => (
								<th
									key={i}
									style={{
										textAlign: 'left',
										padding: '0.75rem 1rem',
										animation: 'pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
									}}
								>
									<div
										style={{
											height: '0.75rem',
											background: '#e5e7eb',
											borderRadius: '4px',
											width: '60%',
										}}
									/>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{Array.from({ length: rows }).map((_, rowIdx) => (
							<TableRowSkeleton key={rowIdx} columns={columns} />
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
