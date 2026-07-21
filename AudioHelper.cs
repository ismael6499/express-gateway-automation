using System;
using System.Runtime.InteropServices;

namespace AudioHelper {
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr pNotify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr pNotify);
        [PreserveSig] int GetChannelCount(out uint pnChannelCount);
        [PreserveSig] int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
        [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
        [PreserveSig] int GetMasterVolumeLevel(out float pfLevelDB);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
        [PreserveSig] int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
        [PreserveSig] int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
        [PreserveSig] int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
        [PreserveSig] int VolumeStepUp(ref Guid pguidEventContext);
        [PreserveSig] int VolumeStepDown(ref Guid pguidEventContext);
        [PreserveSig] int QueryHardwareSupport(out uint pdwHardwareSupport);
    }

    [Guid("C02216F6-8C67-4B5B-9786-D5C4DF585117"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation {
        [PreserveSig] int GetPeakValue(out float pfPeak);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        [PreserveSig] int Activate(ref Guid id, uint clsCtx, IntPtr activationParams, out IntPtr ppInterface);
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint stateMask, out IntPtr ppDevices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    class Program {
        static void Main() {
            try {
                var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
                IMMDevice dev;
                int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
                if (hr < 0) {
                    Console.WriteLine("{{\"volume\":null,\"muted\":null,\"playing\":null,\"error\":\"GetDefaultAudioEndpoint failed (HRESULT {0})\"}}", hr);
                    return;
                }

                IntPtr volInterfacePtr;
                var volId = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
                hr = dev.Activate(ref volId, 23, IntPtr.Zero, out volInterfacePtr);
                if (hr < 0) {
                    Console.WriteLine("{{\"volume\":null,\"muted\":null,\"playing\":null,\"error\":\"Activate IAudioEndpointVolume failed (HRESULT {0})\"}}", hr);
                    return;
                }
                var volumeEndpoint = Marshal.GetObjectForIUnknown(volInterfacePtr) as IAudioEndpointVolume;

                float volLevel = 0;
                volumeEndpoint.GetMasterVolumeLevelScalar(out volLevel);
                bool isMuted = false;
                volumeEndpoint.GetMute(out isMuted);

                bool isPlaying = false;
                try {
                    IntPtr meterInterfacePtr;
                    var meterId = new Guid("C02216F6-8C67-4B5B-9786-D5C4DF585117");
                    hr = dev.Activate(ref meterId, 23, IntPtr.Zero, out meterInterfacePtr);
                    if (hr >= 0) {
                        var meter = Marshal.GetObjectForIUnknown(meterInterfacePtr) as IAudioMeterInformation;
                        float peakValue = 0;
                        meter.GetPeakValue(out peakValue);
                        isPlaying = peakValue > 0.005f;
                    }
                } catch {
                    // Ignorar fallos al obtener medidor de pico si el dispositivo no lo implementa
                }

                Console.WriteLine("{{\"volume\":{0},\"muted\":{1},\"playing\":{2}}}", 
                    Math.Round(volLevel * 100), 
                    isMuted.ToString().ToLower(), 
                    isPlaying.ToString().ToLower());
            } catch (Exception ex) {
                Console.WriteLine("{{\"volume\":null,\"muted\":null,\"playing\":null,\"error\":\"{0}\"}}", ex.Message.Replace("\"", "\\\""));
            }
        }
    }
}
