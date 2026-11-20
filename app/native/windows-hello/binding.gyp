{
    'targets': [
        {
            'target_name': 'windows-hello',
            'sources': ['windowsHello.cpp'],
            'libraries': ['windowsapp.lib', 'user32.lib'],
            'msvs_settings': {
                'VCCLCompilerTool': {
                    'ExceptionHandling': 1,
                    'AdditionalOptions': ['/std:c++20', '/permissive-', '/bigobj'],
                },
            },
        },
    ],
}
