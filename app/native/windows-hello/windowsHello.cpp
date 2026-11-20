#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <roapi.h>
#include <userconsentverifierinterop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.h>
#include <winrt/Windows.Security.Credentials.UI.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <node_api.h>
#include <cstring>
#include <memory>
#include <string>

using namespace winrt::Windows::Foundation;
using namespace winrt::Windows::Security::Credentials;
using namespace winrt::Windows::Security::Credentials::UI;
using winrt::Windows::Security::Cryptography::CryptographicBuffer;

struct HelloRequest {
    napi_async_work work{};
    napi_deferred deferred{};
    HWND window{};
    std::string message;
    int32_t availability{E_FAIL};
    bool succeeded{};
};

static bool verifyWithHelloKey() {
    constexpr wchar_t credentialName[] = L"org.tabby.vault-unlock";
    auto result = KeyCredentialManager::OpenAsync(credentialName).get();
    if (result.Status() == KeyCredentialStatus::NotFound) {
        result = KeyCredentialManager::RequestCreateAsync(credentialName, KeyCredentialCreationOption::FailIfExists).get();
        if (result.Status() == KeyCredentialStatus::CredentialAlreadyExists) {
            result = KeyCredentialManager::OpenAsync(credentialName).get();
        }
    }
    if (result.Status() != KeyCredentialStatus::Success) {
        return false;
    }
    const auto challenge = CryptographicBuffer::GenerateRandom(32);
    return result.Credential().RequestSignAsync(challenge).get().Status() == KeyCredentialStatus::Success;
}

static void execute(napi_env, void* data) {
    auto& request = *static_cast<HelloRequest*>(data);
    const HRESULT initialized = RoInitialize(RO_INIT_MULTITHREADED);
    if (FAILED(initialized)) {
        request.availability = initialized;
        return;
    }
    try {
        const auto status = UserConsentVerifier::CheckAvailabilityAsync().get();
        request.availability = static_cast<int32_t>(status);
        if (status != UserConsentVerifierAvailability::Available && status != UserConsentVerifierAvailability::DeviceBusy) {
            RoUninitialize();
            return;
        }
        const auto interop = winrt::try_get_activation_factory<UserConsentVerifier, IUserConsentVerifierInterop>();
        if (!request.window) {
            if (!interop && !KeyCredentialManager::IsSupportedAsync().get()) {
                request.availability = E_NOINTERFACE;
            }
        } else if (interop) {
            const auto message = winrt::to_hstring(request.message);
            auto operation = winrt::capture<IAsyncOperation<UserConsentVerificationResult>>(
                interop, &IUserConsentVerifierInterop::RequestVerificationForWindowAsync, request.window,
                reinterpret_cast<HSTRING>(winrt::get_abi(message)));
            request.succeeded = operation.get() == UserConsentVerificationResult::Verified;
        } else {
            // Windows 10 can verify a Hello-backed signing request without the HWND interop.
            request.succeeded = verifyWithHelloKey();
        }
    } catch (const winrt::hresult_error& error) {
        request.availability = error.code().value;
    } catch (...) {
        // A failed request leaves the master passphrase available as a fallback.
    }
    RoUninitialize();
}

static void complete(napi_env env, napi_status status, void* data) {
    std::unique_ptr<HelloRequest> request(static_cast<HelloRequest*>(data));
    napi_value result;
    if (request->window) {
        napi_get_boolean(env, status == napi_ok && request->succeeded, &result);
    } else {
        napi_create_int32(env, status == napi_ok ? request->availability : E_FAIL, &result);
    }
    napi_resolve_deferred(env, request->deferred, result);
    napi_delete_async_work(env, request->work);
}

static napi_value start(napi_env env, napi_callback_info info, bool verifyWindow) {
    auto request = std::make_unique<HelloRequest>();
    napi_value args[2];
    size_t count = 2;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != (verifyWindow ? 2u : 0u)) {
        napi_throw_type_error(env, nullptr, verifyWindow ? "Expected a window handle and a verification message" : "Expected no arguments");
        return nullptr;
    }
    if (verifyWindow) {
        void* handle;
        size_t length;
        char message[256];
        if (napi_get_buffer_info(env, args[0], &handle, &length) != napi_ok || length != sizeof(HWND) ||
            napi_get_value_string_utf8(env, args[1], message, sizeof(message), &length) != napi_ok) {
            napi_throw_type_error(env, nullptr, "Expected a window handle and a verification message");
            return nullptr;
        }
        std::memcpy(&request->window, handle, sizeof(HWND));
        DWORD processId = 0;
        GetWindowThreadProcessId(request->window, &processId);
        if (processId != GetCurrentProcessId()) {
            napi_throw_type_error(env, nullptr, "Invalid verification window");
            return nullptr;
        }
        request->message.assign(message, length);
    }

    napi_value promise, name;
    napi_create_promise(env, &request->deferred, &promise);
    napi_create_string_utf8(env, "Windows Hello", NAPI_AUTO_LENGTH, &name);
    if (napi_create_async_work(env, nullptr, name, execute, complete, request.get(), &request->work) == napi_ok) {
        if (napi_queue_async_work(env, request->work) == napi_ok) {
            request.release();
            return promise;
        }
        napi_delete_async_work(env, request->work);
    }
    napi_value unavailable;
    if (request->window) {
        napi_get_boolean(env, false, &unavailable);
    } else {
        napi_create_int32(env, E_FAIL, &unavailable);
    }
    napi_resolve_deferred(env, request->deferred, unavailable);
    return promise;
}

static napi_value init(napi_env env, napi_value exports) {
    napi_value verify;
    napi_create_function(env, "verify", NAPI_AUTO_LENGTH, [](napi_env env, napi_callback_info info) {
        return start(env, info, true);
    }, nullptr, &verify);
    napi_set_named_property(env, exports, "verify", verify);
    napi_value checkAvailability;
    napi_create_function(env, "checkAvailability", NAPI_AUTO_LENGTH, [](napi_env env, napi_callback_info info) {
        return start(env, info, false);
    }, nullptr, &checkAvailability);
    napi_set_named_property(env, exports, "checkAvailability", checkAvailability);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
