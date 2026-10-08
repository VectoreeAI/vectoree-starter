import { useEffect, useMemo, useState } from 'react';
import {
  createRecord,
  deleteRecord,
  getRecords,
  getTableSchema,
  updateRecord,
  type TableColumn,
} from '../api';
import { useI18n } from '../i18n';

const PAGE = 50;
const READONLY = new Set(['id', 'createdAt', 'updatedAt', 'created_at', 'updated_at']);

type Row = Record<string, unknown>;

export function DatabaseScreen({
  table,
  ready,
  reloadToken = 0,
}: {
  table: string | null;
  ready: boolean;
  reloadToken?: number;
}) {
  const { t } = useI18n();
  const [columns, setColumns] = useState<TableColumn[]>([]);
  const [records, setRecords] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | undefined>();
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; id?: string; values: Record<string, string> } | null>(
    null,
  );

  const writable = useMemo(() => columns.filter((column) => !column.isPrimaryKey && !READONLY.has(column.name)), [columns]);
  const headers = useMemo(() => {
    if (columns.length > 0) return columns.map((column) => column.name);
    const names = new Set<string>();
    for (const row of records) {
      for (const key of Object.keys(row)) names.add(key);
    }
    return [...names];
  }, [columns, records]);

  useEffect(() => {
    setOffset(0);
    setEditor(null);
  }, [table]);

  useEffect(() => {
    if (!table) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const schema = await getTableSchema(table);
        const order = schema.columns.some((column) => column.name === 'created_at')
          ? 'created_at.desc'
          : schema.columns.some((column) => column.name === 'createdAt')
            ? 'createdAt.desc'
            : schema.columns.some((column) => column.name === 'id')
              ? 'id.desc'
              : undefined;
        const page = await getRecords(table, { limit: PAGE, offset, ...(order ? { order } : {}) });
        if (cancelled) return;
        setColumns(schema.columns);
        setRecords(page.records);
        setTotal(page.total);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('loadRecordsFail'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [table, offset, reloadToken]);

  if (!ready) {
    return (
      <div className="db-main">
        <p className="note">{t('loadingTables')}</p>
      </div>
    );
  }

  if (!table) {
    return (
      <div className="db-main">
        <div className="empty panel">
          <p className="eyebrow">{t('database')}</p>
          <h2 className="display" style={{ fontSize: 32 }}>
            {t('noTables')}
          </h2>
          <p className="note">{t('noTablesNote')}</p>
        </div>
      </div>
    );
  }

  const selected = table;
  const hasMore = total !== undefined ? offset + records.length < total : records.length === PAGE;

  async function reload() {
    setOffset(0);
    const page = await getRecords(selected, { limit: PAGE, offset: 0 });
    setRecords(page.records);
    setTotal(page.total);
  }

  function openCreate() {
    const values: Record<string, string> = {};
    for (const column of writable) values[column.name] = column.type === 'boolean' ? 'false' : '';
    setEditor({ mode: 'create', values });
  }

  function openEdit(row: Row) {
    const id = row.id;
    if (typeof id !== 'string' && typeof id !== 'number') return;
    const values: Record<string, string> = {};
    for (const column of writable) {
      const value = row[column.name];
      if (column.type === 'boolean') values[column.name] = value === true ? 'true' : 'false';
      else if (value === null || value === undefined) values[column.name] = '';
      else if (typeof value === 'object') values[column.name] = JSON.stringify(value, null, 2);
      else values[column.name] = String(value);
    }
    setEditor({ mode: 'edit', id: String(id), values });
  }

  async function onSave() {
    if (!editor) return;
    setError('');
    try {
      const row = buildRow(writable, editor.values);
      if (editor.mode === 'create') await createRecord(selected, row);
      else if (editor.id) await updateRecord(selected, editor.id, row);
      setEditor(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveRecordFail'));
    }
  }

  async function onDelete(row: Row) {
    const id = row.id;
    if ((typeof id !== 'string' && typeof id !== 'number') || !window.confirm(t('confirmDeleteRecord'))) return;
    setError('');
    try {
      await deleteRecord(selected, String(id));
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deleteRecordFail'));
    }
  }

  return (
    <div className="db-main">
      <div className="row">
        <h2 className="db-title">{table}</h2>
        <button className="btn-ghost" type="button" onClick={() => void reload()}>
          {t('refresh')}
        </button>
        <button className="btn" type="button" onClick={openCreate} disabled={writable.length === 0}>
          {t('newRow')}
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {loading ? <p className="note">{t('loadingRecords')}</p> : null}
      <div className="db-scroll">
        <table className="db-table">
          <thead>
            <tr>
              {headers.map((name) => (
                <th key={name}>{name}</th>
              ))}
              <th> </th>
            </tr>
          </thead>
          <tbody>
            {records.map((row, index) => (
              <tr key={String(row.id ?? index)}>
                {headers.map((name) => (
                  <td key={name} className={name === 'id' ? 'mono' : undefined}>
                    {formatCell(row[name])}
                  </td>
                ))}
                <td>
                  <button className="btn-ghost" type="button" onClick={() => openEdit(row)}>
                    {t('edit')}
                  </button>
                  <button className="btn-ghost" type="button" onClick={() => void onDelete(row)}>
                    {t('delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button className="btn-ghost" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          {t('prev')}
        </button>
        <button className="btn-ghost" type="button" disabled={!hasMore} onClick={() => setOffset(offset + PAGE)}>
          {t('next')}
        </button>
        <span className="note">
          {total !== undefined
            ? t('range', { from: offset + 1, to: offset + records.length, total })
            : t('rows', { count: records.length })}
        </span>
      </div>
      {editor ? (
        <form
          className="panel stack"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave();
          }}
        >
          <p className="eyebrow">{editor.mode === 'create' ? t('createRow') : t('editRow', { id: editor.id ?? '' })}</p>
          {writable.map((column) => (
            <label key={column.name} className="field-label">
              <span className="eyebrow">
                {column.name} · {column.type}
              </span>
              {column.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={editor.values[column.name] === 'true'}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      values: { ...editor.values, [column.name]: event.target.checked ? 'true' : 'false' },
                    })
                  }
                />
              ) : column.type === 'json' ? (
                <textarea
                  className="field"
                  value={editor.values[column.name] ?? ''}
                  onChange={(event) => setEditor({ ...editor, values: { ...editor.values, [column.name]: event.target.value } })}
                />
              ) : (
                <input
                  className="field"
                  type={column.type === 'integer' || column.type === 'float' ? 'number' : 'text'}
                  step={column.type === 'float' ? 'any' : undefined}
                  value={editor.values[column.name] ?? ''}
                  onChange={(event) => setEditor({ ...editor, values: { ...editor.values, [column.name]: event.target.value } })}
                />
              )}
            </label>
          ))}
          <div className="row">
            <button className="btn" type="submit">
              {t('save')}
            </button>
            <button className="btn-ghost" type="button" onClick={() => setEditor(null)}>
              {t('cancel')}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function buildRow(columns: TableColumn[], values: Record<string, string>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const column of columns) {
    const raw = values[column.name] ?? '';
    if (column.type === 'boolean') {
      row[column.name] = raw === 'true';
      continue;
    }
    if (!raw.trim()) continue;
    if (column.type === 'integer') row[column.name] = Number.parseInt(raw, 10);
    else if (column.type === 'float') row[column.name] = Number(raw);
    else if (column.type === 'json') row[column.name] = JSON.parse(raw) as unknown;
    else row[column.name] = raw;
  }
  return row;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
