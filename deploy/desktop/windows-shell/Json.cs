using System;
using System.Collections.Generic;
using System.Globalization;
using System.Web.Script.Serialization;

namespace Zhiqu.Desktop
{
    internal static class Json
    {
        private static JavaScriptSerializer Serializer()
        {
            return new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024, RecursionLimit = 100 };
        }

        internal static string Stringify(object value)
        {
            return Serializer().Serialize(value);
        }

        internal static Dictionary<string, object> Object(string json)
        {
            return Serializer().DeserializeObject(json) as Dictionary<string, object>;
        }

        internal static Dictionary<string, object> Object(object value)
        {
            return value as Dictionary<string, object>;
        }

        internal static string Text(Dictionary<string, object> body, string key)
        {
            object value;
            return body != null && body.TryGetValue(key, out value) ? value as string : null;
        }

        internal static int? Integer(Dictionary<string, object> body, string key)
        {
            object value;
            if (body == null || !body.TryGetValue(key, out value) || value == null) return null;
            if (value is int) return (int)value;
            int parsed;
            return int.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out parsed) ? parsed : (int?)null;
        }

        internal static string Limit(string value, int length)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            return value.Length <= length ? value : value.Substring(0, length);
        }
    }
}
