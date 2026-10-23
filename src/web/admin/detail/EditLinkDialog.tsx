import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ChangePolicy, LinkDetail, UpdateLinkBody } from '../../../shared/api.ts';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Button } from '../../ui/Button.tsx';
import { Dialog } from '../../ui/Dialog.tsx';
import { Field } from '../../ui/Field.tsx';
import { Switch } from '../../ui/Switch.tsx';
import { api, keys } from '../api.ts';
import { NetworksField, networksProblem, splitNetworks } from '../create/NetworksField.tsx';
import { PolicyPicker } from '../create/PolicyPicker.tsx';

const toDateInput = (ms: number | null) =>
  ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';

export function EditLinkDialog({ link, open, onClose }: { link: LinkDetail; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(link.label);
  const [expires, setExpires] = useState(toDateInput(link.expiresAt));
  const [maxDownloads, setMaxDownloads] = useState(link.maxDownloads ? String(link.maxDownloads) : '');
  const [removePassword, setRemovePassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [onChange, setOnChange] = useState<ChangePolicy>(link.onChange);
  const [networks, setNetworks] = useState(link.allowedNetworks.join('\n'));

  const save = useMutation({
    mutationFn: () => {
      const patch: UpdateLinkBody = {
        label,
        expiresAt: expires ? new Date(expires).getTime() : null,
        maxDownloads: maxDownloads ? Number(maxDownloads) : null,
        onChange,
        allowedNetworks: splitNetworks(networks),
      };
      if (newPassword) patch.password = newPassword;
      else if (removePassword) patch.password = null;
      return api.updateLink(link.id, patch);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.link(link.id), updated);
      queryClient.invalidateQueries({ queryKey: keys.links });
      setNewPassword('');
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('actions.edit')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={(newPassword.length > 0 && newPassword.length < 4) || networksProblem(networks) !== null}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field
          label={t('create.label')}
          value={label}
          maxLength={120}
          onChange={(event) => setLabel(event.target.value)}
        />
        <Field
          label={t('detail.expires')}
          type="datetime-local"
          value={expires}
          onChange={(event) => setExpires(event.target.value)}
          hint={!expires ? t('common.never') : undefined}
        />
        <Field
          label={t('create.maxDownloads')}
          type="number"
          inputMode="numeric"
          min={1}
          placeholder={t('create.unlimited')}
          value={maxDownloads}
          onChange={(event) => setMaxDownloads(event.target.value.replace(/\D/g, ''))}
        />
        <Field
          label={t('detail.passwordChange')}
          value={newPassword}
          autoComplete="off"
          className="[&_input]:font-mono"
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <PolicyPicker value={onChange} onChange={setOnChange} />
        <NetworksField value={networks} onChange={setNetworks} />
        {link.hasPassword && !newPassword && (
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm">{t('detail.passwordRemove')}</span>
            <Switch checked={removePassword} onChange={setRemovePassword} label={t('detail.passwordRemove')} />
          </div>
        )}
        {save.isError && <p className="text-sm text-danger">{t('common.error')}</p>}
      </div>
    </Dialog>
  );
}
