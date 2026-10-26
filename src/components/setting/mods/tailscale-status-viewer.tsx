import { NetworkPingRounded, OpenInNewRounded } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  List,
  ListItem,
  ListItemText,
  Typography,
} from '@mui/material'
import type { Ref } from 'react'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { BaseDialog, DialogRef } from '@/components/base'
import { useVerge } from '@/hooks/use-verge'
import {
  getTailscaleStatus,
  pingTailscalePeer,
  type TailscalePeer,
  type TailscaleStatus,
} from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { openExternalUrl } from '@/utils/open-external-url'

interface ViewerError {
  code?: string
  detail: string
}

function toViewerError(error: any): ViewerError {
  if (typeof error === 'string') return { detail: error }
  return {
    code: typeof error?.code === 'string' ? error.code : undefined,
    detail: error?.detail ?? error?.message ?? String(error),
  }
}

function peerAddress(peer: TailscalePeer) {
  return peer.dnsName || peer.ips[0] || peer.hostname
}

function connectionLabel(peer: TailscalePeer) {
  if (peer.endpoint) return `direct · ${peer.endpoint}`
  if (peer.relay) return `relay · ${peer.relay}`
  return ''
}

export function TailscaleStatusViewer({ ref }: { ref?: Ref<DialogRef> }) {
  const { t } = useTranslation()
  const { verge } = useVerge()
  const tunEnabled = verge?.enable_tun_mode ?? false

  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<TailscaleStatus | null>(null)
  const [error, setError] = useState<ViewerError | null>(null)
  const [pinging, setPinging] = useState<string | null>(null)
  const [pings, setPings] = useState<Record<string, string>>({})
  const busyRef = useRef(false)

  const refresh = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const next = await getTailscaleStatus()
      setStatus(next)
      setError(null)
    } catch (err) {
      setStatus(null)
      setError(toViewerError(err))
    } finally {
      busyRef.current = false
    }
  }, [])

  useImperativeHandle(ref, () => ({
    open: () => setOpen(true),
    close: () => setOpen(false),
  }))

  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [open, refresh])

  const onPing = async (peer: TailscalePeer) => {
    const ip = peer.ips[0]
    if (!ip) return
    setPinging(ip)
    try {
      const result = await pingTailscalePeer(ip)
      if (result.error) throw new Error(result.error)
      const latency = Math.round((result.latencySeconds ?? 0) * 1000)
      const via = result.endpoint
        ? ` · ${result.endpoint}`
        : result.relay
          ? ` · ${result.relay}`
          : ''
      setPings((previous) => ({ ...previous, [ip]: `${latency} ms${via}` }))
    } catch (err) {
      showNotice.error(err)
    } finally {
      setPinging(null)
    }
  }

  const unsupported = error?.code === 'tailscale_core_unsupported'
  const notConfigured = error?.code === 'tailscale_not_configured'

  return (
    <BaseDialog
      open={open}
      title={t('settings.modals.tailscale.status.title')}
      contentSx={{ width: { xs: 320, sm: 560 } }}
      okBtn={t('shared.actions.close')}
      onClose={() => setOpen(false)}
      onOk={() => setOpen(false)}
    >
      {error && (
        <Alert severity={unsupported ? 'info' : 'warning'} sx={{ mb: 1 }}>
          <Typography variant="body2">
            {unsupported
              ? t('settings.modals.tailscale.status.coreUnsupported')
              : notConfigured
                ? t('settings.modals.tailscale.status.notConfigured')
                : error.detail}
          </Typography>
        </Alert>
      )}

      {status && status.magicDnsSuffix && !tunEnabled && (
        <Alert severity="info" sx={{ mb: 1 }}>
          {t('settings.modals.tailscale.status.magicDnsNeedsTun')}
        </Alert>
      )}

      {!status && !error && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      )}

      {status && (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Chip
              size="small"
              color={status.backendState === 'Running' ? 'success' : 'warning'}
              label={status.backendState || 'Unknown'}
            />
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {status.hostname}
            </Typography>
            {status.ips.map((ip) => (
              <Chip key={ip} size="small" variant="outlined" label={ip} />
            ))}
          </Box>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block' }}
          >
            {status.tailnet
              ? t('settings.modals.tailscale.status.tailnet', {
                  name: status.tailnet,
                })
              : null}
            {status.magicDnsSuffix
              ? ` · ${t('settings.modals.tailscale.status.magicDns', {
                  suffix: status.magicDnsSuffix,
                })}`
              : null}
            {status.version
              ? ` · ${t('settings.modals.tailscale.status.version', {
                  version: status.version,
                })}`
              : null}
          </Typography>

          {status.authUrl && (
            <Box sx={{ mt: 1 }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<OpenInNewRounded />}
                onClick={() => {
                  void openExternalUrl(status.authUrl!).catch((err) => {
                    showNotice.error(err)
                  })
                }}
              >
                {t('settings.modals.tailscale.status.authorize')}
              </Button>
            </Box>
          )}

          {status.health.map((item) => (
            <Alert key={item} severity="warning" sx={{ mt: 1 }}>
              {item}
            </Alert>
          ))}

          <Divider sx={{ my: 1 }} />
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            {t('settings.modals.tailscale.status.peers', {
              count: status.peers.length,
            })}
          </Typography>
          {status.peers.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              {t('settings.modals.tailscale.status.noPeers')}
            </Typography>
          ) : (
            <List dense disablePadding>
              {status.peers.map((peer) => {
                const ip = peer.ips[0] ?? ''
                const connection = connectionLabel(peer)
                return (
                  <ListItem
                    key={`${peer.hostname}-${ip}`}
                    disableGutters
                    secondaryAction={
                      <Button
                        size="small"
                        startIcon={<NetworkPingRounded />}
                        loading={pinging === ip}
                        loadingPosition="start"
                        disabled={!ip || pinging !== null}
                        onClick={() => void onPing(peer)}
                      >
                        {t('settings.modals.tailscale.status.ping')}
                      </Button>
                    }
                  >
                    <ListItemText
                      primary={
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.75,
                          }}
                        >
                          <Box
                            sx={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              bgcolor: peer.online
                                ? 'success.main'
                                : 'text.disabled',
                            }}
                          />
                          <span>{peer.hostname}</span>
                          {peer.exitNodeOption && (
                            <Chip
                              size="small"
                              variant="outlined"
                              label={t(
                                'settings.modals.tailscale.status.exitNode',
                              )}
                            />
                          )}
                        </Box>
                      }
                      secondary={
                        <>
                          <Typography variant="caption" component="span">
                            {peerAddress(peer)}
                          </Typography>
                          {connection ? (
                            <Typography
                              variant="caption"
                              component="span"
                              color="text.secondary"
                            >
                              {` · ${connection}`}
                            </Typography>
                          ) : null}
                          {pings[ip] ? (
                            <Typography
                              variant="caption"
                              component="span"
                              color="success.main"
                            >
                              {` · ${pings[ip]}`}
                            </Typography>
                          ) : null}
                        </>
                      }
                    />
                  </ListItem>
                )
              })}
            </List>
          )}
        </>
      )}
    </BaseDialog>
  )
}
