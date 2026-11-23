package com.example.shop.common;

import java.util.List;
import java.util.function.Function;
import java.util.stream.Collectors;

public final class Strings {
  private Strings() {}

  public static <T> String join(List<T> items, Function<? super T, String> label) {
    return items.stream().map(label).collect(Collectors.joining(", "));
  }

  public static boolean isBlank(String value) {
    return value == null || value.isBlank();
  }
}
