using System;
using System.Runtime.InteropServices;

namespace AudioHelper {
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume {
        int RegisterControlChangeNotify(IntPtr pNotify);
        int UnregisterControlChangeNotify(IntPtr pNotify);
        int GetChannelCount(out uint pnChannelCount);
        int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
        int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
        int GetMasterVolumeLevel(out float pfLevelDB);
        int GetMasterVolumeLevelScalar(out float pfLevel);
        int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
        int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
        int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
        int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
        int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
        int VolumeStepUp(ref Guid pguidEventContext);
        int VolumeStepDown(ref Guid pguidEventContext);
        int QueryHardwareSupport(out uint pdwHardwareSupport);
    }

    [Guid("C02216F6-8C67-4B5B-9786-D5C4DF585117"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation {
        int GetPeakValue(out float pfPeak);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        int Activate(ref Guid id, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object value);
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, uint stateMask, out IntPtr ppDevices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    class Program {
        static void Main() {
            try {
                var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
                IMMDevice dev;
                enumerator.GetDefaultAudioEndpoint(0, 1, out dev);

                object volObj;
                var volId = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
                dev.Activate(ref volId, 23, IntPtr.Zero, out volObj);
                var volumeEndpoint = volObj as IAudioEndpointVolume;

                float volLevel = 0;
                volumeEndpoint.GetMasterVolumeLevelScalar(out volLevel);
                bool isMuted = false;
                volumeEndpoint.GetMute(out isMuted);

                object meterObj;
                var meterId = new Guid("C02216F6-8C67-4B5B-9786-D5C4DF585117");
                dev.Activate(ref meterId, 23, IntPtr.Zero, out meterObj);
                var meter = meterObj as IAudioMeterInformation;

                float peakValue = 0;
                meter.GetPeakValue(out peakValue);

                bool isPlaying = peakValue > 0.005f;

                Console.WriteLine("{{\"volume\":{0},\"muted\":{1},\"playing\":{2}}}", 
                    Math.Round(volLevel * 100), 
                    isMuted.ToString().ToLower(), 
                    isPlaying.ToString().ToLower());
            } catch (Exception ex) {
                Console.WriteLine("{{\"error\":\"{0}\"}}", ex.Message.Replace("\"", "\\\""));
            }
        }
    }
}
