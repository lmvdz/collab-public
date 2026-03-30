import React, {
	useCallback,
	useEffect,
	useMemo,
	useState,
} from 'react';
import type {
	FolderTableData,
	FolderTableFile,
} from '@collab/shared/types';
import { displayBasename } from '@collab/shared/path-utils';
import './FolderTableView.css';

type SortDirection = 'asc' | 'desc';

interface SortState {
	column: string;
	direction: SortDirection;
}

interface FolderTableViewProps {
	folderPath: string;
	onSelectFile: (path: string) => void;
}

function extractFolderName(
	folderPath: string,
): string {
	return displayBasename(folderPath) || folderPath;
}

function formatCellValue(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'boolean') return value ? '\u2713' : '\u2013';
	if (Array.isArray(value)) return value.join(', ');
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

function formatDate(isoString: string): string {
	const date = new Date(isoString);
	return date.toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

function compareValues(
	a: unknown,
	b: unknown,
	direction: SortDirection,
): number {
	const aNull = a === undefined || a === null;
	const bNull = b === undefined || b === null;
	if (aNull && bNull) return 0;
	if (aNull) return 1;
	if (bNull) return -1;

	if (typeof a === 'number' && typeof b === 'number') {
		const diff = a - b;
		return direction === 'asc' ? diff : -diff;
	}

	const aStr = formatCellValue(a).toLowerCase();
	const bStr = formatCellValue(b).toLowerCase();
	const cmp = aStr.localeCompare(bStr);
	return direction === 'asc' ? cmp : -cmp;
}

function sortFiles(
	files: FolderTableFile[],
	sort: SortState,
): FolderTableFile[] {
	const sorted = [...files];
	sorted.sort((a, b) => {
		if (sort.column === 'filename') {
			const cmp = a.filename
				.toLowerCase()
				.localeCompare(b.filename.toLowerCase());
			return sort.direction === 'asc' ? cmp : -cmp;
		}
		if (sort.column === 'modified') {
			const diff =
				new Date(a.mtime).getTime() -
				new Date(b.mtime).getTime();
			return sort.direction === 'asc' ? diff : -diff;
		}
		return compareValues(
			a.frontmatter[sort.column],
			b.frontmatter[sort.column],
			sort.direction,
		);
	});
	return sorted;
}

export const FolderTableView: React.FC<
	FolderTableViewProps
> = ({ folderPath, onSelectFile }) => {
	const [data, setData] =
		useState<FolderTableData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [sort, setSort] = useState<SortState>({
		column: 'filename',
		direction: 'asc',
	});

	useEffect(() => {
		let stale = false;
		setData(null);
		setError(null);

		window.api
			.readFolderTable(folderPath)
			.then((result) => {
				if (!stale) {
					setData(result);
					setError(null);
				}
			})
			.catch((err) => {
				if (!stale) {
					console.error(
						'Failed to load folder table:',
						err,
					);
					setError('Failed to load folder contents');
				}
			});

		return () => {
			stale = true;
		};
	}, [folderPath]);

	useEffect(() => {
		return window.api.onFsChanged((events) => {
			const relevant = events.some(
				(e) => e.dirPath === folderPath,
			);
			if (relevant) {
				window.api
					.readFolderTable(folderPath)
					.then((result) => {
						setData(result);
						setError(null);
					})
					.catch(() => {});
			}
		});
	}, [folderPath]);

	const handleHeaderClick = useCallback(
		(column: string) => {
			setSort((prev) => {
				if (prev.column === column) {
					return {
						column,
						direction:
							prev.direction === 'asc'
								? 'desc'
								: 'asc',
					};
				}
				return { column, direction: 'asc' };
			});
		},
		[],
	);

	const sortedFiles = useMemo(() => {
		if (!data) return [];
		return sortFiles(data.files, sort);
	}, [data, sort]);

	const folderName = useMemo(
		() => extractFolderName(folderPath),
		[folderPath],
	);

	function renderSortIndicator(column: string) {
		if (sort.column !== column) return null;
		return (
			<span className="sort-indicator">
				{sort.direction === 'asc' ? '\u25B2' : '\u25BC'}
			</span>
		);
	}

	if (error) {
		return (
			<div className="folder-table-view">
				<div className="folder-table-heading">
					{folderName}
				</div>
				<div className="folder-table-empty">
					{error}
				</div>
			</div>
		);
	}

	if (!data) return null;

	if (data.files.length === 0) {
		return (
			<div className="folder-table-view">
				<div className="folder-table-heading">
					{folderName}
				</div>
				<div className="folder-table-empty">
					No files in this folder
				</div>
			</div>
		);
	}

	return (
		<div className="folder-table-view">
			<div className="folder-table-heading">
				{folderName}
			</div>
			<div className="folder-table-scroll scrollbar-hover">
				<table className="folder-table">
					<thead>
						<tr>
							<th
								onClick={() =>
									handleHeaderClick('filename')
								}
							>
								Name
								{renderSortIndicator('filename')}
							</th>
							<th
								onClick={() =>
									handleHeaderClick('modified')
								}
							>
								Modified
								{renderSortIndicator('modified')}
							</th>
							{data.columns.map((col) => (
								<th
									key={col}
									onClick={() =>
										handleHeaderClick(col)
									}
								>
									{col}
									{renderSortIndicator(col)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{sortedFiles.map((file) => (
							<tr
								key={file.path}
								onClick={() =>
									onSelectFile(file.path)
								}
							>
								<td title={file.filename}>
									{file.filename}
								</td>
								<td>{formatDate(file.mtime)}</td>
								{data.columns.map((col) => (
									<td key={col}>
										{formatCellValue(
											file.frontmatter[col],
										)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
};
