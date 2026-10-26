import { DevicesRounded } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  List,
  ListItem,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import type { Ref } from 'react'
import { useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  BaseDialog,
  BaseSplitChipEditor,
  DialogRef,
  Switch,
} from '@/components/base'
import { useVerge } from '@/hooks/use-verge'
import { getTailscaleConflict } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { areValidIpCidrs } from '@/utils/network'

import { TailscaleStatusViewer } from './tailscale-status-viewer'

const DEFAULT_NAME = 'TS'
const DEFAULT_HOSTNAME = 'clash-verge'

const splitRoutes = (value: string) =>
  value
    .split(/[,\n;\r]+/)
    .map((item) => item.trim())
    .filter(Boolean)

export function TailscaleViewer({ ref }: { ref?: Ref<DialogRef> }) {
  const { t } = useTranslation()
  const { verge, patchVerge } = useVerge()

  const statusRef = useRef<DialogRef>(null)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<string[]>([])
  const [values, setValues] = useState({
    enable: false,
    name: DEFAULT_NAME,
    hostname: '',
    authKey: '',
    acceptRoutes: false,
    routes: '',
    udp: true,
    dialerProxy: '',
    exitNode: '',
  })

  const routeItems = splitRoutes(values.routes)
  const routeError = routeItems.length > 0 && !areValidIpCidrs(routeItems)

  const openViewer = async () => {
    const settings = verge?.tailscale
    setValues({
      enable: settings?.enable ?? false,
      name: settings?.name ?? DEFAULT_NAME,
      hostname: settings?.hostname ?? '',
      authKey: settings?.auth_key ?? '',
      acceptRoutes: settings?.accept_routes ?? false,
      routes: (settings?.routes ?? []).join(','),
      udp: settings?.udp ?? true,
      dialerProxy: settings?.dialer_proxy ?? '',
      exitNode: settings?.exit_node ?? '',
    })
    setOpen(true)
    try {
      const result = await getTailscaleConflict()
      setConflict(result.conflict ? result.interfaces : [])
    } catch {
      setConflict([])
    }
  }

  useImperativeHandle(ref, () => ({
    open: () => {
      void openViewer()
    },
    close: () => setOpen(false),
  }))

  const onSave = useLockFn(async () => {
    if (routeError) {
      showNotice.error(t('settings.modals.tailscale.messages.invalidRoutes'))
      return
    }
    if (values.enable && !values.authKey.trim()) {
      showNotice.error(t('settings.modals.tailscale.messages.authKeyRequired'))
      return
    }
    try {
      setSaving(true)
      await patchVerge({
        tailscale: {
          enable: values.enable,
          name: values.name.trim() || DEFAULT_NAME,
          hostname: values.hostname.trim() || null,
          auth_key: values.authKey.trim() || null,
          state_dir: verge?.tailscale?.state_dir ?? null,
          accept_routes: values.acceptRoutes,
          routes: routeItems,
          udp: values.udp,
          dialer_proxy: values.dialerProxy.trim() || null,
          exit_node: values.exitNode.trim() || null,
        },
      })
      setOpen(false)
      showNotice.success(t('settings.modals.tailscale.messages.saved'))
    } catch (err: any) {
      showNotice.error(err)
    } finally {
      setSaving(false)
    }
  })

  return (
    <>
      <BaseDialog
        open={open}
        title={
          <Box
            sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}
          >
            <Typography variant="h6">
              {t('settings.modals.tailscale.title')}
            </Typography>
            <Button
              variant="outlined"
              size="small"
              startIcon={<DevicesRounded />}
              onClick={() => {
                if (!values.enable) {
                  showNotice.error(
                    t('settings.modals.tailscale.messages.enableFirst'),
                  )
                  return
                }
                statusRef.current?.open()
              }}
            >
              {t('settings.modals.tailscale.status.title')}
            </Button>
          </Box>
        }
        contentSx={{ width: { xs: 320, sm: 480 } }}
        okBtn={t('shared.actions.save')}
        cancelBtn={t('shared.actions.cancel')}
        loading={saving}
        onClose={() => setOpen(false)}
        onCancel={() => setOpen(false)}
        onOk={onSave}
      >
        {conflict.length > 0 && (
          <Alert severity="warning" sx={{ mb: 1 }}>
            {t('settings.modals.tailscale.messages.conflict', {
              interfaces: conflict.join(', '),
            })}
          </Alert>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {t('settings.modals.tailscale.messages.description')}
        </Typography>
        <List>
          <ListItem sx={{ padding: '5px 2px' }}>
            <ListItemText
              primary={t('settings.modals.tailscale.fields.enable')}
            />
            <Switch
              edge="end"
              checked={values.enable}
              onChange={(_, checked) =>
                setValues((v) => ({ ...v, enable: checked }))
              }
            />
          </ListItem>
          <ListItem sx={{ padding: '5px 2px' }}>
            <ListItemText
              primary={t('settings.modals.tailscale.fields.name')}
            />
            <TextField
              size="small"
              value={values.name}
              placeholder={DEFAULT_NAME}
              sx={{ width: 180 }}
              onChange={(e) =>
                setValues((v) => ({ ...v, name: e.target.value }))
              }
            />
          </ListItem>
          <ListItem sx={{ padding: '5px 2px' }}>
            <ListItemText
              primary={t('settings.modals.tailscale.fields.hostname')}
            />
            <TextField
              size="small"
              value={values.hostname}
              placeholder={DEFAULT_HOSTNAME}
              sx={{ width: 180 }}
              onChange={(e) =>
                setValues((v) => ({ ...v, hostname: e.target.value }))
              }
            />
          </ListItem>
          <ListItem sx={{ padding: '5px 2px', alignItems: 'flex-start' }}>
            <ListItemText
              primary={t('settings.modals.tailscale.fields.authKey')}
              secondary={t('settings.modals.tailscale.messages.authKeyHint')}
              sx={{ pr: 1 }}
            />
            <TextField
              size="small"
              type="password"
              autoComplete="new-password"
              value={values.authKey}
              placeholder="tskey-auth-..."
              sx={{ width: 220 }}
              onChange={(e) =>
                setValues((v) => ({ ...v, authKey: e.target.value }))
              }
            />
          </ListItem>
          <ListItem sx={{ padding: '5px 2px' }}>
            <ListItemText
              primary={t('settings.modals.tailscale.fields.acceptRoutes')}
              secondary={t(
                'settings.modals.tailscale.messages.acceptRoutesHint',
              )}
            />
            <Switch
              edge="end"
              checked={values.acceptRoutes}
              onChange={(_, checked) =>
                setValues((v) => ({ ...v, acceptRoutes: checked }))
              }
            />
          </ListItem>
          <BaseSplitChipEditor
            value={values.routes}
            placeholder="192.168.20.0/24"
            ariaLabel={t('settings.modals.tailscale.fields.routes')}
            error={routeError}
            helperText={
              routeError
                ? t('settings.modals.tailscale.messages.invalidRoutes')
                : t('settings.modals.tailscale.messages.routesHint')
            }
            onChange={(nextValue) =>
              setValues((v) => ({ ...v, routes: nextValue }))
            }
            renderHeader={(modeToggle) => (
              <ListItem sx={{ padding: '5px 2px' }}>
                <ListItemText
                  primary={t('settings.modals.tailscale.fields.routes')}
                />
                {modeToggle ? (
                  <Box sx={{ marginLeft: 'auto' }}>{modeToggle}</Box>
                ) : null}
              </ListItem>
            )}
          />
          <ListItem sx={{ padding: '5px 2px' }}>
            <ListItemText
              primary={t('settings.modals.tailscale.fields.udp')}
              secondary={t('settings.modals.tailscale.messages.udpHint')}
            />
            <Switch
              edge="end"
              checked={values.udp}
              onChange={(_, checked) =>
                setValues((v) => ({ ...v, udp: checked }))
              }
            />
          </ListItem>
          <ListItem sx={{ padding: '5px 2px', alignItems: 'flex-start' }}>
            <ListItemText
              primary={t('settings.modals.tailscale.fields.dialerProxy')}
              secondary={t(
                'settings.modals.tailscale.messages.dialerProxyHint',
              )}
              sx={{ pr: 1 }}
            />
            <TextField
              size="small"
              value={values.dialerProxy}
              placeholder={t(
                'settings.modals.tailscale.fields.dialerProxyPlaceholder',
              )}
              sx={{ width: 180 }}
              onChange={(e) =>
                setValues((v) => ({ ...v, dialerProxy: e.target.value }))
              }
            />
          </ListItem>
          <ListItem sx={{ padding: '5px 2px', alignItems: 'flex-start' }}>
            <ListItemText
              primary={t('settings.modals.tailscale.fields.exitNode')}
              secondary={t('settings.modals.tailscale.messages.exitNodeHint')}
              sx={{ pr: 1 }}
            />
            <TextField
              size="small"
              value={values.exitNode}
              placeholder="nas.example.ts.net"
              sx={{ width: 180 }}
              onChange={(e) =>
                setValues((v) => ({ ...v, exitNode: e.target.value }))
              }
            />
          </ListItem>
        </List>
      </BaseDialog>
      <TailscaleStatusViewer ref={statusRef} />
    </>
  )
}
