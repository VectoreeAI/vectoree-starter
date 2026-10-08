import { useEffect, useState } from 'react';
import {
  createBucket,
  deleteBucket,
  deleteObject,
  getObjects,
  objectDownloadUrl,
  uploadObject,
  type StorageObject,
} from '../api';
import { useI18n } from '../i18n';

export function StorageScreen({
  bucket,
  ready,
  reloadToken = 0,
  onChanged,
}: {
  bucket: string | null;
  ready: boolean;
  reloadToken?: number;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [objects, setObjects] = useState<StorageObject[]>([]);
  const [prefix, setPrefix] = useState('');
  const [bucketName, setBucketName] = useState('demo');
  const [isPublic, setIsPublic] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setPrefix('');
    setKey('');
  }, [bucket]);

  useEffect(() => {
    if (!bucket) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    void getObjects(bucket, { prefix: prefix.trim() || undefined, limit: 100 })
      .then((page) => {
        if (!cancelled) setObjects(page.objects);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not list objects');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bucket, prefix, reloadToken]);

  if (!ready) {
    return (
      <div className="db-main">
        <p className="note">{t('loadingBuckets')}</p>
      </div>
    );
  }

  async function onCreateBucket() {
    setError('');
    try {
      await createBucket(bucketName.trim(), isPublic);
      setBucketName('demo');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('createBucketFail'));
    }
  }

  if (!bucket) {
    return (
      <div className="db-main">
        <div className="empty panel">
          <p className="eyebrow">{t('storage')}</p>
          <h2 className="display" style={{ fontSize: 32 }}>
            {t('noBuckets')}
          </h2>
          <p className="note">{t('noBucketsNote')}</p>
        </div>
        <BucketForm
          bucketName={bucketName}
          isPublic={isPublic}
          onName={setBucketName}
          onPublic={setIsPublic}
          onSubmit={() => void onCreateBucket()}
        />
        {error ? <div className="error">{error}</div> : null}
      </div>
    );
  }

  async function onUpload(file: File | undefined) {
    if (!file || !bucket) return;
    setError('');
    try {
      await uploadObject(bucket, file, key);
      setKey('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('uploadFail'));
    }
  }

  async function onDeleteObject(objectKey: string) {
    if (!bucket || !window.confirm(t('confirmDeleteObject', { key: objectKey }))) return;
    setError('');
    try {
      await deleteObject(bucket, objectKey);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deleteObjectFail'));
    }
  }

  async function onDeleteBucket() {
    if (!bucket || !window.confirm(t('confirmDeleteBucket', { bucket }))) return;
    setError('');
    try {
      await deleteBucket(bucket);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deleteBucketFail'));
    }
  }

  return (
    <div className="db-main">
      <div className="row">
        <h2 className="db-title">{bucket}</h2>
        <button className="btn-ghost" type="button" onClick={() => void onDeleteBucket()}>
          {t('deleteBucket')}
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          const input = event.currentTarget.elements.namedItem('file');
          const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
          void onUpload(file);
          event.currentTarget.reset();
        }}
      >
        <input className="field" name="key" placeholder={t('keyOptional')} value={key} onChange={(event) => setKey(event.target.value)} />
        <input name="file" type="file" />
        <button className="btn" type="submit">
          {t('upload')}
        </button>
      </form>
      <label className="field-label">
        <span className="eyebrow">{t('prefix')}</span>
        <input className="field" value={prefix} onChange={(event) => setPrefix(event.target.value)} />
      </label>
      {loading ? <p className="note">{t('loadingObjects')}</p> : null}
      <div className="db-scroll">
        <table className="db-table">
          <thead>
            <tr>
              <th>key</th>
              <th>size</th>
              <th>mime</th>
              <th>uploaded</th>
              <th> </th>
            </tr>
          </thead>
          <tbody>
            {objects.map((object) => (
              <tr key={object.key}>
                <td className="mono">{object.key}</td>
                <td>{object.size ?? ''}</td>
                <td>{object.mimeType ?? ''}</td>
                <td>{object.uploadedAt ?? ''}</td>
                <td>
                  <a className="btn-ghost" href={objectDownloadUrl(bucket, object.key)}>
                    {t('download')}
                  </a>
                  {object.url ? (
                    <a className="btn-ghost" href={object.url} target="_blank" rel="noreferrer">
                      {t('open')}
                    </a>
                  ) : null}
                  <button className="btn-ghost" type="button" onClick={() => void onDeleteObject(object.key)}>
                    {t('delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <BucketForm
        bucketName={bucketName}
        isPublic={isPublic}
        onName={setBucketName}
        onPublic={setIsPublic}
        onSubmit={() => void onCreateBucket()}
      />
    </div>
  );
}

function BucketForm({
  bucketName,
  isPublic,
  onName,
  onPublic,
  onSubmit,
}: {
  bucketName: string;
  isPublic: boolean;
  onName: (value: string) => void;
  onPublic: (value: boolean) => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  return (
    <form
      className="panel stack"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <p className="eyebrow">{t('createBucket')}</p>
      <input className="field" value={bucketName} onChange={(event) => onName(event.target.value)} />
      <label className="check">
        <input type="checkbox" checked={isPublic} onChange={(event) => onPublic(event.target.checked)} />
        {t('public')}
      </label>
      <button className="btn" type="submit">
        {t('createBucket')}
      </button>
    </form>
  );
}
